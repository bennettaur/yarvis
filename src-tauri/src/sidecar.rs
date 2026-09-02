//! Supervises the Bun sidecar process.
//!
//! On startup the core picks a free loopback port and generates a bearer token,
//! exposes them to the frontend via `get_sidecar_info`, and spawns the sidecar
//! with secrets injected from the Keychain and non-secret configuration
//! injected from `settings.rs`. The sidecar is restarted if it exits.

use std::io::Write;
use std::net::TcpListener;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::sleep;

use crate::custom_providers::build_sidecar_env;
use crate::keychain::{read_root, secret_from_root};
use crate::settings::SettingsState;

/// Webview origins permitted to call the sidecar; the sidecar still requires the
/// bearer token regardless. The Vite dev server's origin is added alongside
/// these, at whichever port this instance runs on (see `instance::dev_port`).
const WEBVIEW_ORIGINS: &str = "tauri://localhost,http://tauri.localhost";

fn origins_for_port(dev_port: u16) -> String {
    format!("http://localhost:{dev_port},{WEBVIEW_ORIGINS}")
}

/// Picks the database the sidecar connects to. The instance override wins so a
/// migration under development runs against its own database rather than the
/// one every other instance shares.
fn database_url(override_url: Option<String>, keychain_url: Option<String>) -> Option<String> {
    override_url.or(keychain_url)
}

/// The instance identity handed to the sidecar. Built here rather than read
/// there so who owns the recurring background work stays one decision, made in
/// `instance.rs`.
fn instance_env(name: &str, background_workers: bool) -> [(&'static str, String); 2] {
    [
        ("YARVIS_INSTANCE", name.to_string()),
        (
            "YARVIS_BACKGROUND_WORKERS",
            if background_workers { "1" } else { "0" }.to_string(),
        ),
    ]
}

/// Size at which the sidecar log is rotated to `.1` on the next spawn. A single
/// session's worth of lines is what a bug report needs; older ones are noise.
const MAX_LOG_BYTES: u64 = 5 * 1024 * 1024;

const TOKEN_BYTES: usize = 32;
const RESTART_DELAY: Duration = Duration::from_secs(1);
const SPAWN_RETRY_DELAY: Duration = Duration::from_secs(2);

/// Connection details handed to the frontend so it can reach the sidecar.
#[derive(Clone, Serialize)]
pub struct SidecarInfo {
    pub port: u16,
    pub token: String,
}

/// A scoped token authorizing only the sidecar's attention-ingest endpoint.
/// Injected into Yarvis-launched Claude Code session shells (see `pty.rs`) so a
/// session's hooks can raise an attention item without holding the full-access
/// bearer above. Kept in managed state so `build_command` and `pty.rs` share it.
#[derive(Clone)]
pub struct AttentionIngestToken(pub String);

/// A scoped token authorizing only the sidecar's MCP endpoint. Injected into
/// Yarvis-launched Claude Code session shells (see `pty.rs`) so a session can
/// call the Yarvis memory tools without holding the full-access bearer. Kept in
/// managed state so `build_command` and `pty.rs` share it.
#[derive(Clone)]
pub struct McpToken(pub String);

/// Lets commands ask the supervisor to restart the sidecar (e.g. after a
/// secret changes, so the new value is injected into a fresh process).
#[derive(Clone)]
pub struct SidecarControl {
    restart: Arc<Notify>,
}

/// Where the sidecar's output is kept. A packaged app has no terminal attached,
/// so without this a crash or a provider error leaves nothing behind to read;
/// the app's Diagnostics view names this path so a bug report can attach it.
pub fn log_path(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_log_dir().map_err(|e| e.to_string())?;
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("sidecar.log"))
}

/// Keeps one previous log beside the current one, so the run before a restart
/// is still readable — which is usually the run that explains the restart.
fn rotate_if_large(path: &PathBuf) {
    let too_big = std::fs::metadata(path)
        .map(|m| m.len() > MAX_LOG_BYTES)
        .unwrap_or(false);
    if too_big {
        let _ = std::fs::rename(path, path.with_extension("log.1"));
    }
}

fn append_line(path: &PathBuf, line: &str) {
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(path)
    {
        let _ = writeln!(file, "{line}");
    }
}

/// Tees one of the sidecar's streams into the log file, keeping the write to
/// this process's own stdout/stderr so `bun run tauri dev` is unchanged.
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

fn pick_free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind("127.0.0.1:0")?;
    let port = listener.local_addr()?.port();
    // Dropping the listener frees the port for the sidecar to bind.
    Ok(port)
}

fn random_token() -> String {
    let mut bytes = [0u8; TOKEN_BYTES];
    rand::rng().fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// Allocates the port/token, registers them as managed state, and spawns the
/// supervisor task.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let port = pick_free_port().map_err(|e| e.to_string())?;
    let token = random_token();
    app.manage(SidecarInfo {
        port,
        token: token.clone(),
    });

    // A separate, narrowly-scoped token for the attention-ingest endpoint, handed
    // to Claude session shells rather than the full-access bearer above.
    app.manage(AttentionIngestToken(random_token()));

    // Likewise for the MCP endpoint: an MCP client holding this can reach the
    // memory tools and nothing else.
    app.manage(McpToken(random_token()));

    let restart = Arc::new(Notify::new());
    app.manage(SidecarControl {
        restart: restart.clone(),
    });

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        supervise(handle, port, token, restart).await;
    });
    Ok(())
}

async fn supervise(app: AppHandle, port: u16, token: String, restart: Arc<Notify>) {
    let log = log_path(&app)
        .inspect_err(|e| eprintln!("[sidecar] no log file ({e}); output stays on stdout only"))
        .ok();
    loop {
        if let Some(path) = &log {
            rotate_if_large(path);
        }
        let mut command = build_command(&app, port, &token);
        command.stdout(Stdio::piped()).stderr(Stdio::piped());
        match command.spawn() {
            Ok(mut child) => {
                if let Some(out) = child.stdout.take() {
                    tee(out, log.clone(), false);
                }
                if let Some(err) = child.stderr.take() {
                    tee(err, log.clone(), true);
                }
                // Wait for the sidecar to exit on its own or for a restart request.
                tokio::select! {
                    status = child.wait() => {
                        eprintln!("[sidecar] exited ({status:?}); restarting shortly");
                    }
                    _ = restart.notified() => {
                        eprintln!("[sidecar] restart requested");
                    }
                }
                // Ensure the process is gone before respawning (no-op if it already exited).
                let _ = child.start_kill();
                let _ = child.wait().await;
                sleep(RESTART_DELAY).await;
            }
            Err(e) => {
                eprintln!("[sidecar] failed to spawn: {e}; retrying shortly");
                sleep(SPAWN_RETRY_DELAY).await;
            }
        }
    }
}

fn build_command(app: &AppHandle, port: u16, token: &str) -> Command {
    let mut cmd = command_base();
    cmd.env("YARVIS_SIDECAR_PORT", port.to_string());
    cmd.env("YARVIS_SIDECAR_TOKEN", token);
    cmd.env(
        "YARVIS_ALLOWED_ORIGINS",
        origins_for_port(crate::instance::dev_port()),
    );

    for (key, value) in instance_env(
        &crate::instance::name(),
        crate::instance::background_workers_enabled(),
    ) {
        cmd.env(key, value);
    }

    // Path to the core's control socket, so the sidecar can ask the core to
    // spawn/kill Claude sessions in workspace PTYs.
    if let Some(sock) = app.try_state::<crate::control::ControlSocketPath>() {
        cmd.env("YARVIS_CORE_SOCK", &sock.0);
    }

    // The scoped attention-ingest token the sidecar validates; the same value is
    // injected into Claude session shells (pty.rs) so their hooks can post.
    if let Some(attn) = app.try_state::<AttentionIngestToken>() {
        cmd.env("YARVIS_ATTENTION_TOKEN", &attn.0);
    }

    // The scoped MCP token the sidecar validates on `/mcp`; the same value is
    // injected into Claude session shells (pty.rs) so their `.mcp.json` resolves.
    if let Some(mcp) = app.try_state::<McpToken>() {
        cmd.env("YARVIS_MCP_TOKEN", &mcp.0);
    }

    // Forward the memory/embedding debug flag when the app was launched with it
    // (e.g. `YARVIS_DEBUG_MEMORY=1 bun run tauri dev`), so the sidecar traces
    // embedder selection and provider calls to stdout.
    if let Ok(value) = std::env::var("YARVIS_DEBUG_MEMORY") {
        cmd.env("YARVIS_DEBUG_MEMORY", value);
    }

    // Same, for MCP: traces what a connected server actually sent, for when its
    // replies don't match the protocol schema.
    if let Ok(value) = std::env::var("YARVIS_DEBUG_MCP") {
        cmd.env("YARVIS_DEBUG_MCP", value);
    }

    // Read the single secrets item once; one Keychain access covers every
    // value injected below.
    let secrets = read_root();
    if let Some(url) = database_url(
        crate::instance::database_url_override(),
        secret_from_root(&secrets, "database_url"),
    ) {
        cmd.env("DATABASE_URL", url);
    }
    if let Some(key) = secret_from_root(&secrets, "anthropic_api_key") {
        cmd.env("ANTHROPIC_API_KEY", key);
    }
    if let Some(key) = secret_from_root(&secrets, "gemini_api_key") {
        cmd.env("GEMINI_API_KEY", key);
    }
    if let Some(key) = secret_from_root(&secrets, "cerebras_api_key") {
        cmd.env("CEREBRAS_API_KEY", key);
    }
    if let Some(key) = secret_from_root(&secrets, "huggingface_api_key") {
        cmd.env("HUGGINGFACE_API_KEY", key);
    }
    if let Some(token) = secret_from_root(&secrets, "github_token") {
        cmd.env("GITHUB_TOKEN", token);
    }
    if let Some(token) = secret_from_root(&secrets, "azure_devops_token") {
        cmd.env("AZURE_DEVOPS_TOKEN", token);
    }
    if let Some(token) = secret_from_root(&secrets, "jira_api_token") {
        cmd.env("JIRA_API_TOKEN", token);
    }
    if let Some(secret) = secret_from_root(&secrets, "google_client_secret") {
        cmd.env("GOOGLE_CLIENT_SECRET", secret);
    }
    if let Some(token) = secret_from_root(&secrets, "telegram_bot_token") {
        cmd.env("TELEGRAM_BOT_TOKEN", token);
    }
    if let Some(ids) = secret_from_root(&secrets, "telegram_allowed_chat_ids") {
        cmd.env("TELEGRAM_ALLOWED_CHAT_IDS", ids);
    }
    if let Some(secret) = secret_from_root(&secrets, "telegram_otp_secret") {
        cmd.env("TELEGRAM_OTP_SECRET", secret);
    }

    // Non-secret configuration that rides alongside the credentials above but
    // lives in `settings.rs`'s `~/.yarvis/settings.json`, not the Keychain.
    let settings = app
        .try_state::<SettingsState>()
        .map(|s| s.snapshot())
        .unwrap_or_default();
    if let Some(url) = settings.azure_devops_org_url {
        cmd.env("AZURE_DEVOPS_ORG_URL", url);
    }
    if let Some(url) = settings.jira_base_url {
        cmd.env("JIRA_BASE_URL", url);
    }
    if let Some(email) = settings.jira_email {
        cmd.env("JIRA_EMAIL", email);
    }
    if let Some(id) = settings.google_client_id {
        cmd.env("GOOGLE_CLIENT_ID", id);
    }
    if let Some(minutes) = settings.telegram_otp_window_minutes {
        cmd.env("TELEGRAM_OTP_WINDOW_MINUTES", minutes.to_string());
    }

    if let Some(json) = build_sidecar_env(&secrets) {
        cmd.env("YARVIS_CUSTOM_PROVIDER_SECRETS", json);
    }

    if let Some(json) = crate::mcp::build_sidecar_env(&secrets) {
        cmd.env("YARVIS_MCP_SECRETS", json);
    }

    if let Some(json) = crate::embeddings_secrets::build_sidecar_env(&secrets) {
        cmd.env("YARVIS_EMBEDDINGS_SECRETS", json);
    }

    // Ensure the child dies with the parent rather than lingering.
    cmd.kill_on_drop(true);
    cmd
}

#[cfg(debug_assertions)]
fn command_base() -> Command {
    // Dev: run the TypeScript entrypoint directly with Bun (no build step).
    let entry = concat!(env!("CARGO_MANIFEST_DIR"), "/../sidecar/src/server.ts");
    let mut cmd = Command::new("bun");
    cmd.arg("run").arg(entry);
    cmd
}

#[cfg(not(debug_assertions))]
fn command_base() -> Command {
    // Production: run the compiled sidecar binary bundled via `externalBin`.
    // TODO(packaging): resolve the bundled binary path from resources and apply
    // the Bun `extractFromBunfs` workaround for the Agent SDK's embedded CLI.
    Command::new("yarvis-sidecar")
}

/// The log file the frontend offers to reveal, so a user chasing a failure can
/// find it without knowing where macOS puts an app's logs.
#[tauri::command]
pub fn get_sidecar_log_path(app: AppHandle) -> Result<String, String> {
    Ok(log_path(&app)?.to_string_lossy().into_owned())
}

#[tauri::command]
pub fn get_sidecar_info(info: tauri::State<'_, SidecarInfo>) -> SidecarInfo {
    info.inner().clone()
}

/// Restarts the sidecar so newly-stored secrets are picked up. The port and
/// token are unchanged, so the frontend's cached connection stays valid.
#[tauri::command]
pub fn restart_sidecar(control: tauri::State<'_, SidecarControl>) {
    control.restart.notify_one();
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_origin_list_carries_this_instances_dev_server() {
        assert_eq!(
            origins_for_port(1437),
            "http://localhost:1437,tauri://localhost,http://tauri.localhost"
        );
    }

    #[test]
    fn a_large_log_is_rotated_aside_so_the_previous_run_survives() {
        let dir = std::env::temp_dir().join(format!("yarvis-log-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("sidecar.log");
        let rotated = log.with_extension("log.1");

        append_line(&log, "small");
        rotate_if_large(&log);
        assert!(!rotated.exists(), "a small log is left alone");

        std::fs::write(&log, vec![b'x'; (MAX_LOG_BYTES + 1) as usize]).unwrap();
        rotate_if_large(&log);
        assert!(rotated.exists(), "an oversized log moves aside");
        assert!(!log.exists(), "and the next run starts a fresh one");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn an_instance_override_beats_the_shared_keychain_database() {
        assert_eq!(
            database_url(
                Some("postgres://dev".into()),
                Some("postgres://main".into())
            ),
            Some("postgres://dev".into())
        );
    }

    #[test]
    fn the_keychain_database_is_used_when_no_override_is_set() {
        assert_eq!(
            database_url(None, Some("postgres://main".into())),
            Some("postgres://main".into())
        );
    }

    #[test]
    fn no_database_is_configured_rather_than_the_wrong_one() {
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
        assert_eq!(
            instance_env("main", true)[1],
            ("YARVIS_BACKGROUND_WORKERS", "1".to_string())
        );
    }
}
