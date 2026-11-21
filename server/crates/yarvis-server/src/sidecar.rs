//! Runs the Bun sidecar and keeps it running.
//!
//! The server picks a free loopback port and a bearer token, then spawns the
//! sidecar with secrets from the secrets blob and non-secret configuration from
//! `settings.json` in its environment. The sidecar is restarted whenever it
//! exits, and on request after a secret changes, so a fresh process gets the
//! new value. Clients never see the port or the token: they reach the sidecar
//! through the `/api/sidecar` proxy ([`crate::sidecar_proxy`]).
//!
//! The sidecar is not started while the secrets blob can't be read (a locked
//! 1Password, an unanswered Keychain prompt, a locked vault). A sidecar
//! started without its database URL and keys would come up looking like a
//! fresh install, and anything it saved on that basis would be wrong. The
//! supervisor retries until the read succeeds, or sooner when asked to
//! restart.

use std::io::Write;
use std::net::TcpListener;
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rand::RngCore;
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::{Notify, watch};
use tokio::time::sleep;

use crate::config::Config;
use crate::events::EventLog;
use crate::secret_blob::{SecretBlob, secret_from_root};
use crate::settings::{Settings, SettingsStore};

/// Size at which the sidecar log is rotated to `.1` on the next spawn. A single
/// run's worth of lines is what a bug report needs; older ones are noise.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

const TOKEN_BYTES: usize = 32;
const RESTART_DELAY: Duration = Duration::from_secs(1);
const SPAWN_RETRY_DELAY: Duration = Duration::from_secs(2);
/// How often to try the secrets blob again while it can't be read. Long enough
/// not to fill the log, short enough that an unlock is picked up quickly; an
/// explicit restart request skips the wait.
const SECRETS_RETRY_DELAY: Duration = Duration::from_secs(5);

/// Env vars that point the sidecar's GitHub and Google clients at local fakes.
/// They exist for the demo recordings, which start the sidecar themselves. The
/// server must never pass them on: the sidecar would send the stored GitHub
/// token and Google credentials wherever they point, and they could be planted
/// in the shell or launchd environment the server inherits.
pub const ENDPOINT_OVERRIDE_VARS: [&str; 4] = [
    "YARVIS_GITHUB_API_URL",
    "YARVIS_GITHUB_GRAPHQL_URL",
    "YARVIS_GOOGLE_CALENDAR_API_URL",
    "YARVIS_GOOGLE_TOKEN_URL",
];

/// Where the sidecar listens and the bearer token it expects.
#[derive(Clone, Debug)]
pub struct Endpoint {
    pub port: u16,
    pub token: String,
}

/// The sidecar's connection details, the scoped tokens handed to the processes
/// that talk to it directly, and the supervisor's restart signal.
#[derive(Clone)]
pub struct Sidecar {
    inner: Arc<Inner>,
}

struct Inner {
    endpoint: Endpoint,
    /// Authorizes only the sidecar's attention-ingest endpoints. Workspace
    /// session shells get this, never the full-access bearer, so a session's
    /// hooks can raise an attention item and register the agent.
    attention_token: String,
    /// Authorizes only the sidecar's MCP endpoint, for the same shells' MCP
    /// clients.
    mcp_token: String,
    restart: Notify,
    /// Whether a sidecar process is up. The port is only reserved while one
    /// is, so the proxy sends nothing there otherwise: another local process
    /// could have bound it and would be handed the bearer token.
    running: AtomicBool,
    log_path: PathBuf,
    /// Variables other modules add to the sidecar's environment, such as the
    /// control socket's path. Applied on the next spawn.
    extra_env: Mutex<Vec<(String, String)>>,
}

impl Sidecar {
    /// Picks a free loopback port and fresh tokens. The process isn't started
    /// until [`Self::supervise`] runs.
    pub fn new(data_dir: &Path) -> std::io::Result<Self> {
        Ok(Self::build(
            Endpoint {
                port: pick_free_port()?,
                token: random_token(),
            },
            data_dir.join("logs").join("sidecar.log"),
            false,
        ))
    }

    /// A sidecar already listening at `endpoint`, for tests.
    pub fn at(endpoint: Endpoint, log_path: PathBuf) -> Self {
        Self::build(endpoint, log_path, true)
    }

    fn build(endpoint: Endpoint, log_path: PathBuf, running: bool) -> Self {
        Self {
            inner: Arc::new(Inner {
                endpoint,
                attention_token: random_token(),
                mcp_token: random_token(),
                restart: Notify::new(),
                running: AtomicBool::new(running),
                log_path,
                extra_env: Mutex::new(Vec::new()),
            }),
        }
    }

    /// Whether a sidecar process is up to take requests.
    pub fn is_running(&self) -> bool {
        self.inner.running.load(Ordering::SeqCst)
    }

    pub fn endpoint(&self) -> &Endpoint {
        &self.inner.endpoint
    }

    pub fn attention_token(&self) -> &str {
        &self.inner.attention_token
    }

    pub fn mcp_token(&self) -> &str {
        &self.inner.mcp_token
    }

    /// Where the sidecar's output is kept. A server run as a LaunchAgent has
    /// no terminal attached, so without this a crash or a provider error
    /// leaves nothing behind to read.
    pub fn log_path(&self) -> &Path {
        &self.inner.log_path
    }

    /// Sets a variable for the sidecar's next spawn. For values other modules
    /// own, such as `YARVIS_CORE_SOCK`. Never a secret: those come from the
    /// secrets blob at spawn, so a restart picks up a change.
    pub fn set_env(&self, key: &str, value: &str) {
        let mut env = self
            .inner
            .extra_env
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        env.retain(|(k, _)| k != key);
        env.push((key.to_string(), value.to_string()));
    }

    /// Asks the supervisor to restart the sidecar, so a changed secret or
    /// setting reaches a fresh process. The port and token stay the same.
    pub fn restart(&self) {
        self.inner.restart.notify_one();
    }

    /// Runs the sidecar until the server exits, restarting it whenever it
    /// stops. The child is killed when this task is dropped.
    pub async fn supervise(self, deps: SupervisorDeps) {
        let log = self.log_path().to_path_buf();
        if let Some(dir) = log.parent()
            && let Err(e) = std::fs::create_dir_all(dir)
        {
            tracing::warn!("no sidecar log file ({e}); output goes to the server's log only");
        }
        let mut vault_unlocked = deps.vault_unlocked.clone();
        loop {
            rotate_if_large(&log);
            // Off the async workers: reading the secrets can block on a
            // 1Password prompt for up to a minute.
            let secrets = deps.secrets.clone();
            let read = tokio::task::spawn_blocking(move || secrets.read_root()).await;
            let root = match read {
                Ok(Ok(root)) => root,
                Ok(Err(e)) => {
                    tracing::warn!("sidecar waiting: the secrets can't be read: {e}");
                    tokio::select! {
                        _ = sleep(SECRETS_RETRY_DELAY) => {}
                        _ = self.inner.restart.notified() => {}
                        _ = vault_changed(&mut vault_unlocked) => {}
                    }
                    continue;
                }
                // A panic here is a bug, so stop rather than spin on it.
                Err(e) => {
                    tracing::error!("sidecar: reading the secrets panicked: {e}");
                    return;
                }
            };
            let mut command = match self.build_command(&deps, &root) {
                Ok(command) => command,
                Err(e) => {
                    tracing::error!("sidecar not starting: {e}; retrying shortly");
                    sleep(SPAWN_RETRY_DELAY).await;
                    continue;
                }
            };
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            let mut child = match command.spawn() {
                Ok(child) => child,
                Err(e) => {
                    tracing::error!("sidecar failed to spawn: {e}; retrying shortly");
                    sleep(SPAWN_RETRY_DELAY).await;
                    continue;
                }
            };
            // Kills what the sidecar started with it, whichever way it stops,
            // including this task being dropped at shutdown.
            let mut tree = child.id().map(ProcessTree);
            self.inner.running.store(true, Ordering::SeqCst);
            if let Some(out) = child.stdout.take() {
                tee(out, log.clone(), false);
            }
            if let Some(err) = child.stderr.take() {
                tee(err, log.clone(), true);
            }
            append_event(
                &deps.events,
                "sidecar.started",
                json!({ "pid": child.id() }),
            )
            .await;
            let reason = tokio::select! {
                status = child.wait() => {
                    // Already reaped, so its pid may be reused: only its group,
                    // which can't be reused while a member lives, is killed.
                    if let Some(tree) = tree.take() {
                        tree.kill_group_only();
                    }
                    tracing::warn!("sidecar exited ({status:?}); restarting shortly");
                    json!({ "reason": "exited", "code": status.ok().and_then(|s| s.code()) })
                }
                _ = self.inner.restart.notified() => {
                    tracing::info!("sidecar restart requested");
                    json!({ "reason": "restart" })
                }
                _ = vault_locked(&mut vault_unlocked) => {
                    tracing::info!("the vault locked; stopping the sidecar until it unlocks");
                    json!({ "reason": "vault.locked" })
                }
            };
            drop(tree);
            // No-op if it already exited.
            let _ = child.start_kill();
            let _ = child.wait().await;
            self.inner.running.store(false, Ordering::SeqCst);
            append_event(&deps.events, "sidecar.stopped", reason).await;
            sleep(RESTART_DELAY).await;
        }
    }

    fn build_command(&self, deps: &SupervisorDeps, secrets: &Value) -> Result<Command, String> {
        // The sidecar inherits the server's environment, so the PATH and debug
        // flags (`YARVIS_DEBUG_MEMORY`, `YARVIS_DEBUG_MCP`) the server was
        // started with reach it.
        let mut cmd = command_base(&deps.config)?;
        let endpoint = self.endpoint();
        cmd.env("YARVIS_SIDECAR_PORT", endpoint.port.to_string());
        cmd.env("YARVIS_SIDECAR_TOKEN", &endpoint.token);
        cmd.env("YARVIS_ATTENTION_TOKEN", self.attention_token());
        cmd.env("YARVIS_MCP_TOKEN", self.mcp_token());
        cmd.env(
            "YARVIS_ALLOWED_ORIGINS",
            allowed_origins(&deps.config.auth.origins),
        );
        // Where OAuth redirects land when the server is reached from elsewhere.
        match deps.config.auth.public_origin() {
            Some(origin) => cmd.env("YARVIS_PUBLIC_ORIGIN", origin),
            None => cmd.env_remove("YARVIS_PUBLIC_ORIGIN"),
        };
        for (key, value) in instance_env(&instance_name(), background_workers_enabled()) {
            cmd.env(key, value);
        }
        if let Some(dir) = &deps.config.sidecar.migrations_dir {
            cmd.env("YARVIS_MIGRATIONS_DIR", dir);
        }
        for (key, value) in self
            .inner
            .extra_env
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
        {
            cmd.env(key, value);
        }
        for (key, value) in sidecar_env(secrets, &deps.settings.snapshot()) {
            cmd.env(key, value);
        }
        // Last, so nothing set above can bring one back.
        strip_endpoint_overrides(&mut cmd);
        // The child dies with the server rather than lingering.
        cmd.kill_on_drop(true);
        // Its own process group, so stopping it can take its children too.
        #[cfg(unix)]
        cmd.process_group(0);
        Ok(cmd)
    }
}

/// The sidecar's process and everything it started. Dropping it kills them:
/// its children hold the secrets from its environment (a `claude -p` run has
/// the provider keys), so none may outlive a stop.
///
/// Agent runs and the voice servers start in process groups of their own, so
/// killing the sidecar's group isn't enough, and once the sidecar dies they're
/// reparented and can't be found by ancestry. So the sidecar is paused first,
/// which keeps it from starting more, and every descendant's group is killed
/// before the sidecar's own. PTY sessions are the server's, not the sidecar's,
/// so they're untouched. A sidecar that exits on its own has its detached
/// children reparented already; the sidecar's own startup sweep ends the agent
/// runs among them.
struct ProcessTree(u32);

impl ProcessTree {
    /// For a sidecar that already exited: no pause or walk, which would act on
    /// whatever process has its pid now.
    fn kill_group_only(self) {
        #[cfg(unix)]
        if let Ok(group) = libc::pid_t::try_from(self.0)
            && group > 1
            && group != unsafe { libc::getpgrp() }
        {
            // SAFETY: a signal to a process group the server created.
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
        std::mem::forget(self);
    }
}

impl Drop for ProcessTree {
    fn drop(&mut self) {
        #[cfg(unix)]
        kill_tree(self.0);
    }
}

#[cfg(unix)]
fn kill_tree(root: u32) {
    let Ok(root) = libc::pid_t::try_from(root) else {
        return;
    };
    // SAFETY: plain syscalls on a pid and process groups we started.
    unsafe { libc::kill(root, libc::SIGSTOP) };
    let own_group = unsafe { libc::getpgrp() };
    let mut groups = descendant_groups(root);
    groups.push(root);
    for group in groups {
        if group > 1 && group != own_group {
            unsafe { libc::killpg(group, libc::SIGKILL) };
        }
    }
}

/// The process groups of every process below `root`, from `ps`. Empty when
/// `ps` can't be run, which leaves only the sidecar's own group to kill.
#[cfg(unix)]
fn descendant_groups(root: libc::pid_t) -> Vec<libc::pid_t> {
    let Ok(out) = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "pid=,ppid=,pgid="])
        .output()
    else {
        tracing::warn!("couldn't list the sidecar's child processes; killing its group only");
        return Vec::new();
    };
    let rows: Vec<[libc::pid_t; 3]> = String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace().map(|f| f.parse().ok());
            Some([fields.next()??, fields.next()??, fields.next()??])
        })
        .collect();
    let mut below = vec![root];
    let mut groups = Vec::new();
    while let Some(parent) = below.pop() {
        for [pid, ppid, pgid] in &rows {
            if *ppid == parent && *pid != parent {
                below.push(*pid);
                if !groups.contains(pgid) {
                    groups.push(*pgid);
                }
            }
        }
    }
    groups
}

/// What the supervisor reads on every spawn.
#[derive(Clone)]
pub struct SupervisorDeps {
    pub config: Arc<Config>,
    pub settings: SettingsStore,
    pub secrets: SecretBlob,
    pub events: EventLog,
    /// Whether the vault is unlocked, when the secrets live in it. An unlock
    /// starts a waiting sidecar at once. A lock stops a running one: it holds
    /// every secret in its environment, so leaving it up would undo the lock.
    pub vault_unlocked: Option<watch::Receiver<bool>>,
}

/// Resolves when the vault's state changes. Never resolves without a vault,
/// or once the vault is gone.
async fn vault_changed(unlocked: &mut Option<watch::Receiver<bool>>) {
    let Some(rx) = unlocked else {
        return std::future::pending::<()>().await;
    };
    if rx.changed().await.is_err() {
        std::future::pending::<()>().await;
    }
}

/// Resolves when the vault locks. Never resolves without a vault.
async fn vault_locked(unlocked: &mut Option<watch::Receiver<bool>>) {
    let Some(rx) = unlocked else {
        return std::future::pending::<()>().await;
    };
    if rx.wait_for(|unlocked| !unlocked).await.is_err() {
        std::future::pending::<()>().await;
    }
}

async fn append_event(events: &EventLog, kind: &str, data: Value) {
    if let Err(e) = events.append(None, kind, data).await {
        tracing::error!("couldn't record {kind}: {e}");
    }
}

/// The environment built from the secrets blob and the settings: every
/// credential the sidecar uses, and the non-secret configuration that rides
/// along with them.
pub fn sidecar_env(secrets: &Value, settings: &Settings) -> Vec<(&'static str, String)> {
    const SECRET_VARS: &[(&str, &str)] = &[
        ("anthropic_api_key", "ANTHROPIC_API_KEY"),
        ("gemini_api_key", "GEMINI_API_KEY"),
        ("cerebras_api_key", "CEREBRAS_API_KEY"),
        ("huggingface_api_key", "HUGGINGFACE_API_KEY"),
        ("github_token", "GITHUB_TOKEN"),
        ("azure_devops_token", "AZURE_DEVOPS_TOKEN"),
        ("jira_api_token", "JIRA_API_TOKEN"),
        ("verify_agent_signing_key", "VERIFY_AGENT_SIGNING_KEY"),
        ("google_client_secret", "GOOGLE_CLIENT_SECRET"),
        ("telegram_bot_token", "TELEGRAM_BOT_TOKEN"),
        ("telegram_allowed_chat_ids", "TELEGRAM_ALLOWED_CHAT_IDS"),
        ("telegram_otp_secret", "TELEGRAM_OTP_SECRET"),
    ];
    let mut env = Vec::new();
    if let Some(url) = database_url(
        database_url_override(),
        secret_from_root(secrets, "database_url"),
    ) {
        env.push(("DATABASE_URL", url));
    }
    for (key, var) in SECRET_VARS {
        if let Some(value) = secret_from_root(secrets, key) {
            env.push((*var, value));
        }
    }
    let plain = [
        (
            "AZURE_DEVOPS_ORG_URL",
            settings.azure_devops_org_url.clone(),
        ),
        ("JIRA_BASE_URL", settings.jira_base_url.clone()),
        ("JIRA_EMAIL", settings.jira_email.clone()),
        ("GOOGLE_CLIENT_ID", settings.google_client_id.clone()),
        (
            "TELEGRAM_OTP_WINDOW_MINUTES",
            settings.telegram_otp_window_minutes.map(|m| m.to_string()),
        ),
    ];
    env.extend(plain.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    let nested = [
        (
            "YARVIS_CUSTOM_PROVIDER_SECRETS",
            crate::custom_providers::build_sidecar_env(secrets),
        ),
        ("YARVIS_MCP_SECRETS", crate::mcp::build_sidecar_env(secrets)),
        (
            "YARVIS_EMBEDDINGS_SECRETS",
            crate::embeddings_secrets::build_sidecar_env(secrets),
        ),
    ];
    env.extend(nested.into_iter().filter_map(|(k, v)| v.map(|v| (k, v))));
    env
}

/// The configured command, or `bun run` on the sidecar's entry point. The
/// default path is fixed when the server is built, so it only works for a
/// server run from the checkout it was built in; a packaged server sets
/// `[sidecar] command`.
fn command_base(config: &Config) -> Result<Command, String> {
    match &config.sidecar.command {
        Some(argv) => {
            let (program, args) = argv
                .split_first()
                .ok_or("[sidecar] command is empty in server.toml")?;
            let mut cmd = Command::new(program);
            cmd.args(args);
            Ok(cmd)
        }
        None => {
            let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../../../sidecar/src/main.ts");
            let mut cmd = Command::new("bun");
            cmd.arg("run").arg(entry);
            Ok(cmd)
        }
    }
}

fn strip_endpoint_overrides(cmd: &mut Command) {
    for var in ENDPOINT_OVERRIDE_VARS {
        cmd.env_remove(var);
    }
}

/// The sidecar's CORS allowlist. The proxy reaches it server-side, so this
/// only matters for a page served by this server. An origin with a comma in it
/// would append a second origin of its own choosing, so one is dropped.
fn allowed_origins(origins: &[String]) -> String {
    origins
        .iter()
        .filter(|o| !o.contains(',') && !o.trim().is_empty())
        .map(|o| o.trim())
        .collect::<Vec<_>>()
        .join(",")
}

/// Picks the database the sidecar connects to. The `YARVIS_DATABASE_URL`
/// override wins, so a server run for testing a migration uses its own
/// database rather than the one stored for everyday use.
fn database_url(override_url: Option<String>, stored_url: Option<String>) -> Option<String> {
    override_url.or(stored_url)
}

fn database_url_override() -> Option<String> {
    env_value("YARVIS_DATABASE_URL")
}

/// Reads an env var, treating an empty value as unset.
fn env_value(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// The instance identity handed to the sidecar. A desktop app or a second
/// server can share the sidecar's database, and only one of them should run
/// the background workers (the Telegram bot, the pollers, the resume sweep),
/// which on a shared database would do the same work twice.
fn instance_env(name: &str, background_workers: bool) -> [(&'static str, String); 2] {
    [
        ("YARVIS_INSTANCE", name.to_string()),
        (
            "YARVIS_BACKGROUND_WORKERS",
            if background_workers { "1" } else { "0" }.to_string(),
        ),
    ]
}

/// `YARVIS_INSTANCE`, or `main` for the primary instance.
fn instance_name() -> String {
    env_value("YARVIS_INSTANCE").unwrap_or_else(|| "main".to_string())
}

/// The primary instance (no `YARVIS_INSTANCE`) runs the background workers
/// unless `YARVIS_BACKGROUND_WORKERS` says otherwise. Only an explicit `1`,
/// `true`, `0` or `false` overrides, so a typo leaves the default in place.
fn background_workers_enabled() -> bool {
    resolve_background_workers(
        env_value("YARVIS_INSTANCE").is_none(),
        env_value("YARVIS_BACKGROUND_WORKERS").as_deref(),
    )
}

fn resolve_background_workers(is_primary: bool, flag: Option<&str>) -> bool {
    match flag.map(str::trim) {
        Some("1" | "true") => true,
        Some("0" | "false") => false,
        _ => is_primary,
    }
}

/// Keeps one previous log beside the current one, so the run before a restart
/// is still readable; it is usually the run that explains the restart.
fn rotate_if_large(path: &Path) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > MAX_LOG_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

fn append_line(path: &Path, line: &str) {
    let mut options = std::fs::OpenOptions::new();
    options.create(true).append(true);
    // 0600: the file collects everything the sidecar prints.
    #[cfg(unix)]
    options.mode(0o600);
    if let Ok(mut file) = options.open(path) {
        let _ = writeln!(file, "{line}");
    }
}

/// Tees one of the sidecar's streams into the log file and the server's own
/// stdout or stderr.
fn tee<R>(reader: R, path: PathBuf, to_stderr: bool)
where
    R: tokio::io::AsyncRead + Unpin + Send + 'static,
{
    tokio::spawn(async move {
        let mut lines = BufReader::new(reader).lines();
        while let Ok(Some(line)) = lines.next_line().await {
            if to_stderr {
                eprintln!("{line}");
            } else {
                println!("{line}");
            }
            append_line(&path, &line);
        }
    });
}

fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    // Dropping the listener frees the port for the sidecar to bind.
    Ok(listener.local_addr()?.port())
}

fn random_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn endpoint_overrides_never_reach_the_sidecar() {
        let mut cmd = Command::new("true");
        cmd.env("YARVIS_GITHUB_API_URL", "https://attacker.example");
        strip_endpoint_overrides(&mut cmd);
        let envs: Vec<_> = cmd.as_std().get_envs().collect();
        for var in ENDPOINT_OVERRIDE_VARS {
            // `None` is how Command records a removal, which also stops an
            // inherited value from passing through.
            assert!(
                envs.contains(&(std::ffi::OsStr::new(var), None)),
                "{var} is not removed"
            );
        }
    }

    #[test]
    fn a_large_log_is_rotated_aside_so_the_previous_run_survives() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("sidecar.log");
        let rotated = log.with_extension("log.1");
        append_line(&log, "small");
        rotate_if_large(&log);
        assert!(!rotated.exists(), "a small log is left alone");
        std::fs::write(&log, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        rotate_if_large(&log);
        assert!(rotated.exists(), "an oversized log moves aside");
        assert!(!log.exists(), "and the next run starts a fresh one");
    }

    #[test]
    fn an_override_beats_the_stored_database_url() {
        assert_eq!(
            database_url(
                Some("postgres://dev".into()),
                Some("postgres://main".into())
            ),
            Some("postgres://dev".into())
        );
        assert_eq!(
            database_url(None, Some("postgres://main".into())),
            Some("postgres://main".into())
        );
        assert_eq!(database_url(None, None), None);
    }

    #[test]
    fn the_sidecar_is_told_which_instance_it_serves_and_whether_it_owns_the_workers() {
        // The names and the "1"/"0" encoding are a contract with
        // `sidecar/src/config.ts`; drifting either side fails open.
        assert_eq!(
            instance_env("migration-test", false),
            [
                ("YARVIS_INSTANCE", "migration-test".to_string()),
                ("YARVIS_BACKGROUND_WORKERS", "0".to_string()),
            ]
        );
        assert!(resolve_background_workers(true, None));
        assert!(!resolve_background_workers(false, None));
        assert!(resolve_background_workers(false, Some("1")));
        assert!(!resolve_background_workers(true, Some("0")));
        assert!(resolve_background_workers(true, Some("yes")));
    }

    #[test]
    fn an_origin_that_could_widen_the_list_is_dropped() {
        assert_eq!(
            allowed_origins(&[
                "http://localhost:7878".into(),
                "https://a.example,https://evil.example".into(),
                " ".into(),
            ]),
            "http://localhost:7878"
        );
    }

    #[test]
    fn secrets_and_settings_reach_the_environment_and_empty_values_do_not() {
        let secrets = json!({
            "anthropic_api_key": "sk-ant",
            "github_token": "",
            "database_url": "postgres://main",
            "customProviders": { "litellm": { "apiKey": "k" } },
        });
        let mut settings = Settings::default();
        settings.jira_email = Some("dev@acme.com".into());
        settings.telegram_otp_window_minutes = Some(30);
        let env = sidecar_env(&secrets, &settings);
        let get = |k: &str| {
            env.iter()
                .find(|(key, _)| *key == k)
                .map(|(_, v)| v.as_str())
        };
        assert_eq!(get("ANTHROPIC_API_KEY"), Some("sk-ant"));
        assert_eq!(get("GITHUB_TOKEN"), None);
        assert_eq!(get("JIRA_EMAIL"), Some("dev@acme.com"));
        assert_eq!(get("TELEGRAM_OTP_WINDOW_MINUTES"), Some("30"));
        assert_eq!(get("JIRA_BASE_URL"), None);
        // The override, when the test runs with one, wins; see the test above.
        assert_eq!(
            get("DATABASE_URL"),
            database_url(database_url_override(), Some("postgres://main".into())).as_deref()
        );
        assert_eq!(
            get("YARVIS_CUSTOM_PROVIDER_SECRETS"),
            Some(r#"{"litellm":{"apiKey":"k"}}"#)
        );
        assert_eq!(get("YARVIS_MCP_SECRETS"), None);
    }

    #[test]
    fn an_empty_command_is_refused() {
        let mut config = Config::default();
        config.sidecar.command = Some(vec![]);
        assert!(command_base(&config).is_err());
    }
}
