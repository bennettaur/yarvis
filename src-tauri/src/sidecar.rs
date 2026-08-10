//! Supervises the Bun sidecar process.
//!
//! On startup the core picks a free loopback port and generates a bearer token,
//! exposes them to the frontend via `get_sidecar_info`, and spawns the sidecar
//! with secrets injected from the Keychain. The sidecar is restarted if it exits.

use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use rand::Rng;
use serde::Serialize;
use tauri::{AppHandle, Manager};
use tokio::process::Command;
use tokio::sync::Notify;
use tokio::time::sleep;

use crate::custom_providers::build_sidecar_env;
use crate::keychain::{read_root, secret_from_root};

/// Origins permitted to call the sidecar. Covers the Vite dev server and the
/// Tauri webview origins; the sidecar still requires the bearer token regardless.
const ALLOWED_ORIGINS: &str = "http://localhost:1420,tauri://localhost,http://tauri.localhost";

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

/// Lets commands ask the supervisor to restart the sidecar (e.g. after a
/// secret changes, so the new value is injected into a fresh process).
#[derive(Clone)]
pub struct SidecarControl {
    restart: Arc<Notify>,
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
    loop {
        match build_command(&app, port, &token).spawn() {
            Ok(mut child) => {
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
    cmd.env("YARVIS_ALLOWED_ORIGINS", ALLOWED_ORIGINS);

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

    // Forward the memory/embedding debug flag when the app was launched with it
    // (e.g. `YARVIS_DEBUG_MEMORY=1 bun run tauri dev`), so the sidecar traces
    // embedder selection and provider calls to stdout.
    if let Ok(value) = std::env::var("YARVIS_DEBUG_MEMORY") {
        cmd.env("YARVIS_DEBUG_MEMORY", value);
    }

    // Read the single secrets item once; one Keychain access covers every
    // value injected below.
    let secrets = read_root();
    if let Some(url) = secret_from_root(&secrets, "database_url") {
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
    if let Some(token) = secret_from_root(&secrets, "github_token") {
        cmd.env("GITHUB_TOKEN", token);
    }
    if let Some(token) = secret_from_root(&secrets, "azure_devops_token") {
        cmd.env("AZURE_DEVOPS_TOKEN", token);
    }
    if let Some(url) = secret_from_root(&secrets, "azure_devops_org_url") {
        cmd.env("AZURE_DEVOPS_ORG_URL", url);
    }
    if let Some(url) = secret_from_root(&secrets, "jira_base_url") {
        cmd.env("JIRA_BASE_URL", url);
    }
    if let Some(email) = secret_from_root(&secrets, "jira_email") {
        cmd.env("JIRA_EMAIL", email);
    }
    if let Some(token) = secret_from_root(&secrets, "jira_api_token") {
        cmd.env("JIRA_API_TOKEN", token);
    }
    if let Some(id) = secret_from_root(&secrets, "google_client_id") {
        cmd.env("GOOGLE_CLIENT_ID", id);
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
    if let Some(minutes) = secret_from_root(&secrets, "telegram_otp_window_minutes") {
        cmd.env("TELEGRAM_OTP_WINDOW_MINUTES", minutes);
    }

    if let Some(json) = build_sidecar_env(&secrets) {
        cmd.env("YARVIS_CUSTOM_PROVIDER_SECRETS", json);
    }

    if let Some(json) = crate::mcp::build_sidecar_env(&secrets) {
        cmd.env("YARVIS_MCP_SECRETS", json);
    }

    if let Some(json) = crate::embeddings_secrets::build_sidecar_env() {
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
