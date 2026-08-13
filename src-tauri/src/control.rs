//! Local control channel: a Unix-domain-socket RPC the Bun sidecar uses to ask
//! the core to do things it can't do itself — spawning, killing, and typing an
//! instruction into a Claude Code session in a workspace PTY.
//!
//! Security model: the socket lives in the app's private data dir (mode 0700) as
//! a mode-0600 file, so only the same user can connect, and a UDS is never
//! reachable over the network. The protocol is deliberately narrow — the sidecar
//! can only start, stop, or talk to a Claude session for a workspace, and chooses
//! only whether to launch the configured agent, not what runs: the command comes
//! from settings, which only the webview can write. The sidecar's `name` does
//! reach the launch line, and that line is typed into an interactive shell rather
//! than exec'd, so `pty::sanitize_session_name` strips it — see that function for
//! why quoting alone is not enough. `claude.send` types free text at a prompt
//! instead, which `pty::send_session_instruction` sanitizes, refuses to send
//! unless the configured agent itself is what reads that prompt, and refuses
//! outright when it opens with a character the agent reads as a command rather
//! than a request. Requests and responses are newline-delimited JSON.

/// Absolute path to the control socket, kept in managed state so `sidecar.rs`
/// can pass it to the child process via env.
#[derive(Clone)]
pub struct ControlSocketPath(pub String);

/// The control channel is a Unix-domain socket, so it only exists on Unix.
/// Windows builds compile a no-op `init` (see the `#[cfg(not(unix))]` stub at
/// the end of this file); the sidecar reads the socket path via `try_state`, so
/// its absence simply means no control channel is offered.
#[cfg(unix)]
pub use unix_impl::init;

#[cfg(unix)]
mod unix_impl {
    use std::path::{Path, PathBuf};

    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use tauri::{AppHandle, Manager};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    use super::ControlSocketPath;
    use crate::pty::{kill_session, send_session_instruction, spawn_claude_session, PtyState};

    /// Cap on a single request line, bounding what one message can buffer.
    const MAX_LINE: usize = 64 * 1024;

    #[derive(Deserialize)]
    struct Request {
        #[serde(default)]
        id: Value,
        method: String,
        #[serde(default)]
        params: Value,
    }

    #[derive(Serialize)]
    struct Response {
        id: Value,
        ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    }

    #[derive(Deserialize)]
    struct SpawnParams {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        cwd: String,
        name: String,
        /// Whether to launch with Remote Control. Absent means off, so a caller
        /// that hasn't been taught about it can't silently opt in.
        #[serde(rename = "remoteControl", default)]
        remote_control: bool,
        /// What the session should start on, appended to the launch line as one
        /// quoted argument. Set by the issue "Start work" sequence, which the
        /// sidecar drives end to end; absent means a session the user drives.
        #[serde(default)]
        instruction: Option<String>,
    }

    #[derive(Deserialize)]
    struct KillParams {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
    }

    #[derive(Deserialize)]
    struct SendParams {
        #[serde(rename = "workspaceId")]
        workspace_id: String,
        /// What to type at the running agent's prompt. Composed by the chat
        /// model, so `pty::send_session_instruction` sanitizes and bounds it.
        instruction: String,
    }

    fn socket_path(app: &AppHandle) -> Result<PathBuf, String> {
        let dir = app.path().app_local_data_dir().map_err(|e| e.to_string())?;
        Ok(dir.join("core-control.sock"))
    }

    /// Prepares the control socket path and starts the accept loop. Must run before
    /// the sidecar is spawned so the socket path is available to inject into its env.
    ///
    /// The path is computed and published synchronously, but the socket is bound on
    /// the Tauri (Tokio) runtime: `UnixListener::bind` needs a running reactor, and
    /// `setup` runs outside one. The sidecar connects lazily (on first request),
    /// long after the bind completes, so binding asynchronously is safe.
    pub fn init(app: &AppHandle) -> Result<(), String> {
        let path = socket_path(app)?;
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
            set_dir_private(parent);
        }
        // Clear a stale socket from a previous run — but only if it really is a
        // socket, so we never follow a symlink or clobber a planted regular file.
        remove_stale_socket(&path)?;

        app.manage(ControlSocketPath(path.to_string_lossy().to_string()));

        let handle = app.clone();
        tauri::async_runtime::spawn(async move {
            let listener = match UnixListener::bind(&path) {
                Ok(listener) => listener,
                Err(e) => {
                    eprintln!("[control] bind failed: {e}");
                    return;
                }
            };
            set_file_private(&path);
            accept_loop(handle, listener).await;
        });
        Ok(())
    }

    async fn accept_loop(app: AppHandle, listener: UnixListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let app = app.clone();
                    tauri::async_runtime::spawn(async move {
                        if let Err(e) = handle_conn(app, stream).await {
                            eprintln!("[control] connection error: {e}");
                        }
                    });
                }
                Err(e) => {
                    eprintln!("[control] accept failed: {e}");
                    // Brief backoff so a broken listener doesn't spin a hot loop.
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    }

    async fn handle_conn(app: AppHandle, stream: UnixStream) -> Result<(), String> {
        let (read_half, mut write_half) = stream.into_split();
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = reader
                .read_line(&mut line)
                .await
                .map_err(|e| e.to_string())?;
            if n == 0 {
                break; // peer closed
            }
            if line.len() > MAX_LINE {
                return Err("control request exceeds size limit".into());
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let resp = dispatch(&app, trimmed);
            let mut out = serde_json::to_string(&resp).map_err(|e| e.to_string())?;
            out.push('\n');
            write_half
                .write_all(out.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    fn dispatch(app: &AppHandle, line: &str) -> Response {
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                return Response {
                    id: Value::Null,
                    ok: false,
                    error: Some(format!("bad request: {e}")),
                }
            }
        };
        match run_method(app, &req.method, req.params) {
            Ok(()) => Response {
                id: req.id,
                ok: true,
                error: None,
            },
            Err(e) => Response {
                id: req.id,
                ok: false,
                error: Some(e),
            },
        }
    }

    fn run_method(app: &AppHandle, method: &str, params: Value) -> Result<(), String> {
        let state = app.state::<PtyState>();
        match method {
            "claude.spawn" => {
                let p: SpawnParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                spawn_claude_session(
                    app,
                    state.inner(),
                    &p.workspace_id,
                    p.cwd,
                    &p.name,
                    p.remote_control,
                    p.instruction.as_deref(),
                )
            }
            "claude.kill" => {
                let p: KillParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                kill_session(state.inner(), &format!("ws-claude:{}", p.workspace_id));
                Ok(())
            }
            "claude.send" => {
                let p: SendParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                send_session_instruction(app, state.inner(), &p.workspace_id, &p.instruction)
            }
            other => Err(format!("unknown method: {other}")),
        }
    }

    /// Workspace ids are UUIDs; reject anything else so the value can't smuggle a
    /// surprising character into the session key.
    fn validate_workspace_id(id: &str) -> Result<(), String> {
        let ok = !id.is_empty()
            && id.len() <= 64
            && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
        if ok {
            Ok(())
        } else {
            Err("invalid workspaceId".into())
        }
    }

    fn set_dir_private(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700));
    }

    fn set_file_private(path: &Path) {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600));
    }

    fn remove_stale_socket(path: &Path) -> Result<(), String> {
        use std::os::unix::fs::FileTypeExt;
        match std::fs::symlink_metadata(path) {
            Ok(meta) if meta.file_type().is_socket() => {
                std::fs::remove_file(path).map_err(|e| e.to_string())
            }
            Ok(_) => Err("control socket path is occupied by a non-socket file".into()),
            Err(_) => Ok(()), // nothing there yet
        }
    }
}

/// On non-Unix platforms there is no control channel; the sidecar runs without
/// one. Kept as a no-op so `lib.rs` can call `control::init` unconditionally.
#[cfg(not(unix))]
pub fn init(_app: &tauri::AppHandle) -> Result<(), String> {
    Ok(())
}
