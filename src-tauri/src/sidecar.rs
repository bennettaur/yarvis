//! Supervises the Bun sidecar process.
//!
//! On startup the core picks a free loopback port and generates a bearer token,
//! exposes them to the frontend via `get_sidecar_info`, and spawns the sidecar
//! with secrets injected from the Keychain. The sidecar is restarted if it exits.

use std::net::TcpListener;
use std::sync::Arc;
use std::time::Duration;

use rand::RngCore;
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

fn build_command(_app: &AppHandle, port: u16, token: &str) -> Command {
    let mut cmd = command_base();
    cmd.env("YARVIS_SIDECAR_PORT", port.to_string());
    cmd.env("YARVIS_SIDECAR_TOKEN", token);
    cmd.env("YARVIS_ALLOWED_ORIGINS", ALLOWED_ORIGINS);

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
    if let Some(token) = secret_from_root(&secrets, "github_token") {
        cmd.env("GITHUB_TOKEN", token);
    }
    if let Some(id) = secret_from_root(&secrets, "google_client_id") {
        cmd.env("GOOGLE_CLIENT_ID", id);
    }
    if let Some(secret) = secret_from_root(&secrets, "google_client_secret") {
        cmd.env("GOOGLE_CLIENT_SECRET", secret);
    }

    if let Some(json) = build_sidecar_env(&secrets) {
        cmd.env("YARVIS_CUSTOM_PROVIDER_SECRETS", json);
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
