//! Starts and supervises the bundled `yarvis-server` in local mode.
//!
//! The app owns three things about that server: the port it listens on, where
//! it finds the bundled sidecar, migrations and web UI, and the device token
//! the app signs in with. Everything else in its `server.toml` (the secrets
//! backend, the ssh-agent, the RP ID) is the user's, so a start merges the
//! app's keys into the file rather than rewriting it.
//!
//! Pairing runs `yarvis-server device add`, which needs only local access to
//! the server's data, the same trust as reading its setup code. The token goes
//! straight into the Keychain.

use std::io::Write;
use std::net::TcpListener;
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;
use tokio::process::Command;
use tokio::time::{sleep, timeout};

/// Every scope: the window runs the whole UI, admin screens included.
pub const DEVICE_SCOPES: &str = "read,chat,approve,admin";

/// A first start creates the database and starts the sidecar, which can take a
/// while on a cold disk.
pub const STARTUP_TIMEOUT: Duration = Duration::from_secs(60);

const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const HEALTH_POLL: Duration = Duration::from_millis(250);
const FIRST_RESTART_DELAY: Duration = Duration::from_secs(1);
const MAX_RESTART_DELAY: Duration = Duration::from_secs(30);
/// A run this long counts as healthy, so the next crash restarts quickly again.
const STABLE_RUN: Duration = Duration::from_secs(60);
/// Size at which `server.log` is rotated to `.1` on the next start.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

/// Where the bundled pieces are. A release build finds them inside the app
/// bundle; a dev build uses the checkout.
#[derive(Debug, Clone)]
pub struct BundledPaths {
    pub server_bin: PathBuf,
    pub web_dir: PathBuf,
    /// Unset in a dev build, where the server runs the sidecar from source.
    pub sidecar_bin: Option<PathBuf>,
    pub migrations_dir: Option<PathBuf>,
}

impl BundledPaths {
    #[cfg(debug_assertions)]
    pub fn locate(_app: &tauri::AppHandle) -> Result<Self, String> {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("..");
        Ok(Self {
            server_bin: root.join("server/target/debug/yarvis-server"),
            web_dir: root.join("dist"),
            sidecar_bin: None,
            migrations_dir: None,
        })
    }

    /// `externalBin` puts the binaries beside the app's own executable and
    /// `resources` puts `dist/` and `drizzle/` in the resource dir (see
    /// `tauri.release.conf.json`). Never a `PATH` lookup: whatever answered to
    /// the name would get the user's secrets.
    #[cfg(not(debug_assertions))]
    pub fn locate(app: &tauri::AppHandle) -> Result<Self, String> {
        use tauri::Manager;
        let exe = tauri::utils::platform::current_exe()
            .map_err(|e| format!("can't locate the app executable: {e}"))?;
        let resources = app
            .path()
            .resource_dir()
            .map_err(|e| format!("can't locate the app's resources: {e}"))?;
        let suffix = std::env::consts::EXE_SUFFIX;
        Ok(Self {
            server_bin: exe.with_file_name(format!("yarvis-server{suffix}")),
            web_dir: resources.join("dist"),
            sidecar_bin: Some(exe.with_file_name(format!("yarvis-sidecar{suffix}"))),
            migrations_dir: Some(resources.join("drizzle")),
        })
    }
}

/// Uses `preferred` when it is free, so the server's URL stays the same from
/// one run to the next, and otherwise any free loopback port.
pub fn pick_port(preferred: Option<u16>) -> std::io::Result<u16> {
    if let Some(port) = preferred {
        if TcpListener::bind(("127.0.0.1", port)).is_ok() {
            return Ok(port);
        }
    }
    // Dropping the listener frees the port for the server to bind.
    Ok(TcpListener::bind("127.0.0.1:0")?.local_addr()?.port())
}

pub fn origin(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

/// Merges the keys the app owns into `existing` (the current `server.toml`,
/// or empty). A file that doesn't parse is an error, so a typo the user made
/// is reported rather than overwritten.
pub fn render_server_config(
    existing: &str,
    port: u16,
    default_data_dir: &Path,
    paths: &BundledPaths,
) -> Result<String, String> {
    use toml::{Table, Value};

    let mut doc: Table = existing
        .parse()
        .map_err(|e| format!("server.toml isn't valid TOML: {e}"))?;

    let server = section(&mut doc, "server")?;
    server.insert("bind".into(), format!("127.0.0.1:{port}").into());
    server
        .entry("data_dir")
        .or_insert_with(|| path_value(default_data_dir));
    server.insert("web_dir".into(), path_value(&paths.web_dir));

    // The window loads the server at 127.0.0.1, and a browser on this Mac is
    // likelier to use localhost. Both are added beside any the user listed.
    let auth = section(&mut doc, "auth")?;
    let origins = auth
        .entry("origins")
        .or_insert_with(|| Value::Array(Vec::new()))
        .as_array_mut()
        .ok_or("server.toml's auth.origins isn't a list")?;
    for wanted in [origin(port), format!("http://localhost:{port}")] {
        if !origins.iter().any(|o| o.as_str() == Some(wanted.as_str())) {
            origins.push(wanted.into());
        }
    }

    let sidecar = section(&mut doc, "sidecar")?;
    if let Some(bin) = &paths.sidecar_bin {
        sidecar.insert("command".into(), Value::Array(vec![path_value(bin)]));
    }
    if let Some(dir) = &paths.migrations_dir {
        sidecar.insert("migrations_dir".into(), path_value(dir));
    }
    if sidecar.is_empty() {
        doc.remove("sidecar");
    }

    toml::to_string(&doc).map_err(|e| e.to_string())
}

fn section<'a>(doc: &'a mut toml::Table, name: &str) -> Result<&'a mut toml::Table, String> {
    doc.entry(name)
        .or_insert_with(|| toml::Value::Table(toml::Table::new()))
        .as_table_mut()
        .ok_or_else(|| format!("server.toml's {name} isn't a table"))
}

fn path_value(path: &Path) -> toml::Value {
    path.to_string_lossy().into_owned().into()
}

/// Mints a device token with `yarvis-server device add`. The token is the last
/// non-empty line of its stdout.
pub async fn pair(server_bin: &Path, config: &Path, device_name: &str) -> Result<String, String> {
    let output = Command::new(server_bin)
        .arg("--config")
        .arg(config)
        .args([
            "device",
            "add",
            "--name",
            device_name,
            "--scopes",
            DEVICE_SCOPES,
        ])
        .stdin(Stdio::null())
        .output()
        .await
        .map_err(|e| format!("couldn't run {}: {e}", server_bin.display()))?;
    if !output.status.success() {
        return Err(format!(
            "pairing with the local server failed ({}): {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .rfind(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "pairing with the local server printed no token".to_string())
}

/// The HTTP status of `GET path` on the local server. A hand-written request
/// rather than an HTTP client, since this is the app's only HTTP call and it
/// only ever goes to loopback.
pub async fn get_status(port: u16, path: &str, bearer: Option<&str>) -> Result<u16, String> {
    let request = async {
        let mut stream = TcpStream::connect(("127.0.0.1", port))
            .await
            .map_err(|e| e.to_string())?;
        let auth = bearer
            .map(|t| format!("Authorization: Bearer {t}\r\n"))
            .unwrap_or_default();
        let head = format!(
            "GET {path} HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\n{auth}Connection: close\r\n\r\n"
        );
        stream
            .write_all(head.as_bytes())
            .await
            .map_err(|e| e.to_string())?;
        let mut status_line = Vec::new();
        let mut byte = [0u8; 1];
        while status_line.len() < 256 {
            if stream.read(&mut byte).await.map_err(|e| e.to_string())? == 0 || byte[0] == b'\n' {
                break;
            }
            status_line.push(byte[0]);
        }
        parse_status(&String::from_utf8_lossy(&status_line))
    };
    timeout(REQUEST_TIMEOUT, request)
        .await
        .map_err(|_| "the local server didn't answer in time".to_string())?
}

fn parse_status(line: &str) -> Result<u16, String> {
    let mut parts = line.split_whitespace();
    match (parts.next(), parts.next()) {
        (Some(version), Some(code)) if version.starts_with("HTTP/") => {
            code.parse().map_err(|_| format!("bad status line: {line}"))
        }
        _ => Err(format!("bad status line: {line}")),
    }
}

/// Waits for `/api/health` to answer 200.
pub async fn wait_healthy(port: u16, limit: Duration) -> Result<(), String> {
    let deadline = Instant::now() + limit;
    loop {
        if get_status(port, "/api/health", None).await == Ok(200) {
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(format!(
                "the local server didn't start within {}s",
                limit.as_secs()
            ));
        }
        sleep(HEALTH_POLL).await;
    }
}

/// Whether the server still accepts `token`. `false` only on a 401, which means
/// the device was revoked or the server's data was reset; any other failure is
/// an error, so a hiccup never throws away a working pairing.
pub async fn token_accepted(port: u16, token: &str) -> Result<bool, String> {
    match get_status(port, "/api/devices/me", Some(token)).await? {
        200 => Ok(true),
        401 => Ok(false),
        other => Err(format!("checking the device token got HTTP {other}")),
    }
}

/// "Tauri on <host name>", the name the device shows under in Settings.
pub fn device_name() -> String {
    let mut buf = [0u8; 256];
    // SAFETY: the buffer is valid for its length, and gethostname writes at
    // most that many bytes.
    let ok = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) } == 0;
    let host = ok
        .then(|| {
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            String::from_utf8_lossy(&buf[..end]).into_owned()
        })
        .map(|h| h.trim_end_matches(".local").to_string())
        .filter(|h| !h.is_empty())
        .unwrap_or_else(|| "this Mac".to_string());
    format!("Tauri on {host}")
}

/// Restarts the server whenever it exits, until [`Supervisor::stop`].
pub struct Supervisor {
    pid: Arc<Mutex<Option<u32>>>,
    stopping: Arc<AtomicBool>,
}

impl Supervisor {
    /// Runs `command()` in a loop. A command is built per start so each run
    /// gets a fresh `Command`. Output goes to this process's stdout/stderr and,
    /// when `log` is set, to that file.
    pub fn start<F>(command: F, log: Option<PathBuf>) -> Self
    where
        F: Fn() -> Command + Send + 'static,
    {
        let pid = Arc::new(Mutex::new(None));
        let stopping = Arc::new(AtomicBool::new(false));
        let (task_pid, task_stopping) = (pid.clone(), stopping.clone());
        tauri::async_runtime::spawn(async move {
            let mut delay = FIRST_RESTART_DELAY;
            while !task_stopping.load(Ordering::SeqCst) {
                if let Some(path) = &log {
                    rotate_if_large(path);
                }
                let mut cmd = command();
                cmd.stdin(Stdio::null())
                    .stdout(Stdio::piped())
                    .stderr(Stdio::piped())
                    .kill_on_drop(true);
                let started = Instant::now();
                match cmd.spawn() {
                    Ok(mut child) => {
                        *task_pid.lock().unwrap_or_else(|e| e.into_inner()) = child.id();
                        if let Some(out) = child.stdout.take() {
                            tee(out, log.clone(), false);
                        }
                        if let Some(err) = child.stderr.take() {
                            tee(err, log.clone(), true);
                        }
                        let status = child.wait().await;
                        *task_pid.lock().unwrap_or_else(|e| e.into_inner()) = None;
                        if task_stopping.load(Ordering::SeqCst) {
                            break;
                        }
                        eprintln!("[server] exited ({status:?}); restarting");
                    }
                    Err(e) => eprintln!("[server] couldn't start: {e}; retrying"),
                }
                if started.elapsed() >= STABLE_RUN {
                    delay = FIRST_RESTART_DELAY;
                }
                sleep(delay).await;
                delay = (delay * 2).min(MAX_RESTART_DELAY);
            }
        });
        Self { pid, stopping }
    }

    /// Asks the running server to shut down and stops restarting it. SIGINT
    /// rather than SIGKILL, so the server stops its own sidecar on the way out.
    pub fn stop(&self) {
        self.stopping.store(true, Ordering::SeqCst);
        if let Some(pid) = *self.pid.lock().unwrap_or_else(|e| e.into_inner()) {
            // SAFETY: kill only sends a signal to the child this supervisor
            // started and is still waiting on, so the pid can't be reused yet.
            unsafe {
                libc::kill(pid as libc::pid_t, libc::SIGINT);
            }
        }
    }
}

/// Keeps one previous log beside the current one: the run before a restart is
/// usually the one that explains it.
fn rotate_if_large(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > MAX_LOG_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

fn append_line(path: &Path, line: &str) {
    // 0600: the server prints its one-time setup code, and nothing but this
    // user has any business reading it.
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .mode(0o600)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

fn tee<R>(reader: R, path: Option<PathBuf>, to_stderr: bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tauri::async_runtime::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if to_stderr {
                eprintln!("{line}");
            } else {
                println!("{line}");
            }
            if let Some(path) = &path {
                append_line(path, &line);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn paths(release: bool) -> BundledPaths {
        BundledPaths {
            server_bin: "/App/Contents/MacOS/yarvis-server".into(),
            web_dir: "/App/Contents/Resources/dist".into(),
            sidecar_bin: release.then(|| "/App/Contents/MacOS/yarvis-sidecar".into()),
            migrations_dir: release.then(|| "/App/Contents/Resources/drizzle".into()),
        }
    }

    fn parse(text: &str) -> toml::Table {
        text.parse().unwrap()
    }

    /// Writes an executable shell script standing in for `yarvis-server`.
    fn fake_server(dir: &Path, body: &str) -> PathBuf {
        let path = dir.join("yarvis-server");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path
    }

    #[test]
    fn a_first_config_points_the_server_at_the_bundle() {
        let text = render_server_config("", 7123, Path::new("/data/server"), &paths(true)).unwrap();
        let doc = parse(&text);
        assert_eq!(doc["server"]["bind"].as_str(), Some("127.0.0.1:7123"));
        assert_eq!(doc["server"]["data_dir"].as_str(), Some("/data/server"));
        assert_eq!(
            doc["server"]["web_dir"].as_str(),
            Some("/App/Contents/Resources/dist")
        );
        assert_eq!(
            doc["sidecar"]["command"].as_array().unwrap()[0].as_str(),
            Some("/App/Contents/MacOS/yarvis-sidecar")
        );
        assert_eq!(
            doc["sidecar"]["migrations_dir"].as_str(),
            Some("/App/Contents/Resources/drizzle")
        );
        let origins: Vec<_> = doc["auth"]["origins"]
            .as_array()
            .unwrap()
            .iter()
            .map(|o| o.as_str().unwrap())
            .collect();
        assert_eq!(origins, ["http://127.0.0.1:7123", "http://localhost:7123"]);
    }

    #[test]
    fn the_users_own_settings_survive_a_restart() {
        let existing = r#"
            [server]
            data_dir = "/Volumes/Data/yarvis"
            bind = "127.0.0.1:1"
            [secrets]
            backend = "onepassword"
            [auth]
            rp_id = "yarvis.example.com"
            origins = ["https://yarvis.example.com"]
        "#;
        let text =
            render_server_config(existing, 7123, Path::new("/data/server"), &paths(true)).unwrap();
        let doc = parse(&text);
        assert_eq!(doc["secrets"]["backend"].as_str(), Some("onepassword"));
        assert_eq!(doc["auth"]["rp_id"].as_str(), Some("yarvis.example.com"));
        assert_eq!(
            doc["server"]["data_dir"].as_str(),
            Some("/Volumes/Data/yarvis")
        );
        assert_eq!(doc["server"]["bind"].as_str(), Some("127.0.0.1:7123"));
        assert_eq!(doc["auth"]["origins"].as_array().unwrap().len(), 3);
    }

    #[test]
    fn restarting_on_the_same_port_adds_no_duplicate_origins() {
        let once = render_server_config("", 7123, Path::new("/d"), &paths(true)).unwrap();
        let twice = render_server_config(&once, 7123, Path::new("/d"), &paths(true)).unwrap();
        assert_eq!(
            parse(&twice)["auth"]["origins"].as_array().unwrap().len(),
            2
        );
    }

    #[test]
    fn a_dev_build_leaves_the_sidecar_to_the_servers_default() {
        let text = render_server_config("", 7123, Path::new("/d"), &paths(false)).unwrap();
        assert!(!parse(&text).contains_key("sidecar"));
    }

    #[test]
    fn a_broken_config_is_reported_not_overwritten() {
        let err = render_server_config("[server\nbind=", 7123, Path::new("/d"), &paths(true))
            .unwrap_err();
        assert!(err.contains("server.toml"), "{err}");
    }

    #[test]
    fn a_free_preferred_port_is_kept() {
        let port = pick_port(None).unwrap();
        assert_eq!(pick_port(Some(port)).unwrap(), port);
    }

    #[test]
    fn a_taken_preferred_port_is_replaced() {
        let taken = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = taken.local_addr().unwrap().port();
        assert_ne!(pick_port(Some(port)).unwrap(), port);
    }

    #[test]
    fn status_lines_parse() {
        assert_eq!(parse_status("HTTP/1.1 200 OK\r"), Ok(200));
        assert_eq!(parse_status("HTTP/1.1 401 Unauthorized"), Ok(401));
        assert!(parse_status("SSH-2.0-OpenSSH").is_err());
        assert!(parse_status("").is_err());
    }

    #[tokio::test]
    async fn pairing_reads_the_token_and_passes_the_config_and_scopes() {
        let dir = tempfile::tempdir().unwrap();
        let args = dir.path().join("args");
        let bin = fake_server(
            dir.path(),
            &format!(
                "echo \"$@\" > {args}\necho 'Created device Tauri on test'\necho\necho tok123\n",
                args = args.display()
            ),
        );
        let config = dir.path().join("server.toml");

        let token = pair(&bin, &config, "Tauri on test").await.unwrap();

        assert_eq!(token, "tok123");
        assert_eq!(
            std::fs::read_to_string(&args).unwrap().trim(),
            format!(
                "--config {} device add --name Tauri on test --scopes read,chat,approve,admin",
                config.display()
            )
        );
    }

    #[tokio::test]
    async fn a_failed_pairing_reports_the_servers_error() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_server(dir.path(), "echo 'database is locked' >&2\nexit 3");
        let err = pair(&bin, &dir.path().join("server.toml"), "x")
            .await
            .unwrap_err();
        assert!(err.contains("database is locked"), "{err}");
    }

    #[tokio::test]
    async fn a_pairing_that_prints_nothing_is_an_error() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_server(dir.path(), "exit 0");
        assert!(pair(&bin, &dir.path().join("server.toml"), "x")
            .await
            .is_err());
    }

    /// Answers every connection with `status` and records the request heads.
    async fn fake_http(status: &'static str) -> (u16, Arc<Mutex<Vec<String>>>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let seen = Arc::new(Mutex::new(Vec::new()));
        let record = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut socket, _)) = listener.accept().await {
                let mut buf = vec![0u8; 4096];
                let n = socket.read(&mut buf).await.unwrap_or(0);
                record
                    .lock()
                    .unwrap()
                    .push(String::from_utf8_lossy(&buf[..n]).into_owned());
                let _ = socket
                    .write_all(format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n").as_bytes())
                    .await;
            }
        });
        (port, seen)
    }

    #[tokio::test]
    async fn a_healthy_server_is_seen() {
        let (port, seen) = fake_http("200 OK").await;
        wait_healthy(port, Duration::from_secs(5)).await.unwrap();
        assert!(seen.lock().unwrap()[0].starts_with("GET /api/health HTTP/1.1\r\n"));
    }

    #[tokio::test]
    async fn a_server_that_never_answers_times_out() {
        let port = pick_port(None).unwrap();
        let err = wait_healthy(port, Duration::from_millis(300))
            .await
            .unwrap_err();
        assert!(err.contains("didn't start"), "{err}");
    }

    #[tokio::test]
    async fn the_token_check_sends_the_bearer_token() {
        let (port, seen) = fake_http("200 OK").await;
        assert_eq!(token_accepted(port, "tok123").await, Ok(true));
        let request = seen.lock().unwrap()[0].clone();
        assert!(request.starts_with("GET /api/devices/me "), "{request}");
        assert!(
            request.contains("\r\nAuthorization: Bearer tok123\r\n"),
            "{request}"
        );
    }

    #[tokio::test]
    async fn a_revoked_token_reads_as_not_accepted() {
        let (port, _) = fake_http("401 Unauthorized").await;
        assert_eq!(token_accepted(port, "old").await, Ok(false));
    }

    #[tokio::test]
    async fn a_server_error_is_not_mistaken_for_a_revoked_token() {
        let (port, _) = fake_http("500 Internal Server Error").await;
        assert!(token_accepted(port, "tok").await.is_err());
    }

    async fn wait_for(what: &str, mut done: impl FnMut() -> bool) {
        let deadline = Instant::now() + Duration::from_secs(10);
        while !done() {
            assert!(Instant::now() < deadline, "timed out waiting for {what}");
            sleep(Duration::from_millis(50)).await;
        }
    }

    #[tokio::test]
    async fn a_server_that_exits_is_started_again() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path().join("runs");
        let bin = fake_server(
            dir.path(),
            &format!("echo run >> {}\necho serving", runs.display()),
        );
        let log = dir.path().join("server.log");

        let supervisor = Supervisor::start(move || Command::new(&bin), Some(log.clone()));
        let count = || {
            std::fs::read_to_string(&runs)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        };
        wait_for("a restart", || count() >= 2).await;
        supervisor.stop();

        wait_for("the log", || {
            std::fs::read_to_string(&log).is_ok_and(|s| s.contains("serving"))
        })
        .await;
        let mode = std::fs::metadata(&log).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
    }

    #[tokio::test]
    async fn stopping_ends_the_running_server_and_its_restarts() {
        let dir = tempfile::tempdir().unwrap();
        let runs = dir.path().join("runs");
        // Each run appends to a temp file and moves it into place, so the
        // test never reads it half-written.
        let bin = fake_server(
            dir.path(),
            &format!(
                "cat {runs} > {runs}.tmp 2>/dev/null; echo run >> {runs}.tmp; mv {runs}.tmp {runs}\nexec sleep 30",
                runs = runs.display()
            ),
        );
        let count = || {
            std::fs::read_to_string(&runs)
                .map(|s| s.lines().count())
                .unwrap_or(0)
        };

        let supervisor = Supervisor::start(move || Command::new(&bin), None);
        wait_for("the server to start", || count() == 1).await;
        supervisor.stop();
        wait_for("the server to exit", || {
            supervisor.pid.lock().unwrap().is_none()
        })
        .await;

        // Longer than the first restart delay, so a restart would have shown.
        sleep(FIRST_RESTART_DELAY + Duration::from_millis(500)).await;
        assert_eq!(count(), 1);
    }

    #[test]
    fn a_large_log_is_rotated_aside() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("server.log");
        append_line(&log, "small");
        rotate_if_large(&log);
        assert!(!log.with_extension("log.1").exists());

        std::fs::write(&log, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        rotate_if_large(&log);
        assert!(log.with_extension("log.1").exists());
        assert!(!log.exists());
    }

    #[test]
    fn the_device_is_named_after_this_machine() {
        let name = device_name();
        assert!(name.starts_with("Tauri on "), "{name}");
        assert!(name.len() > "Tauri on ".len());
    }
}
