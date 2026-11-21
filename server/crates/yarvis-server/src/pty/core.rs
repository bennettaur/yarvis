//! The PTY commands `POST /api/core/{command}` serves, with the same
//! camelCase arguments the UI passes to `invoke`. Driving a session needs
//! `chat`, reading one needs `read`. Attaching isn't here: it is the
//! `/api/pty/{id}` WebSocket.

use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use super::PtyManager;
use crate::auth::Scope;
use crate::error::ApiError;

/// The scope a PTY command needs, or `None` when `command` isn't one.
pub fn scope_of(command: &str) -> Option<Scope> {
    Some(match command {
        "pty_exists" | "pty_is_busy" | "pty_session_harness" => Scope::Read,
        // The agent commands are user-written and can carry an inline
        // `VAR=secret`, so only a device that may start sessions sees them.
        "get_agent_config" | "pty_write" | "pty_resize" | "pty_kill" | "pty_start_claude" => {
            Scope::Chat
        }
        _ => return None,
    })
}

#[derive(Deserialize)]
struct Id {
    id: String,
}

#[derive(Deserialize)]
struct Write {
    id: String,
    data: String,
}

#[derive(Deserialize)]
struct Resize {
    id: String,
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StartClaude {
    workspace_id: String,
    cwd: String,
    name: String,
    #[serde(default)]
    remote_control: bool,
    #[serde(default)]
    harness: Option<String>,
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args)
        .map_err(|e| ApiError::bad_request("bad arguments").with_detail(e.to_string()))
}

fn value(v: impl serde::Serialize) -> Result<Option<Value>, ApiError> {
    serde_json::to_value(v)
        .map(Some)
        .map_err(ApiError::internal)
}

/// Runs a command [`scope_of`] knows, after the caller has checked its scope.
/// A command's own failure comes back as `400` with the message in `error`,
/// since the UI shows it to the user.
pub async fn run(pty: &PtyManager, command: &str, args: Value) -> Result<Option<Value>, ApiError> {
    let pty = pty.clone();
    let blocking = |f: Box<dyn FnOnce() -> Result<Option<Value>, ApiError> + Send>| async move {
        tokio::task::spawn_blocking(f)
            .await
            .map_err(ApiError::internal)?
    };
    match command {
        "pty_exists" => {
            let Id { id } = parse(args)?;
            value(pty.exists(&id))
        }
        "pty_is_busy" => {
            let Id { id } = parse(args)?;
            value(pty.is_busy(&id))
        }
        "pty_session_harness" => {
            let Id { id } = parse(args)?;
            value(pty.session_harness(&id))
        }
        // Reads settings.json from disk.
        "get_agent_config" => blocking(Box::new(move || value(pty.agent_config()))).await,
        "pty_write" => {
            let Write { id, data } = parse(args)?;
            pty.write(&id, data).await.map_err(ApiError::bad_request)?;
            Ok(None)
        }
        "pty_resize" => {
            let Resize { id, cols, rows } = parse(args)?;
            if cols == 0 || rows == 0 {
                return Err(ApiError::bad_request("cols and rows must be at least 1"));
            }
            pty.resize(&id, cols, rows).map_err(ApiError::bad_request)?;
            Ok(None)
        }
        "pty_kill" => {
            let Id { id } = parse(args)?;
            pty.kill(&id);
            Ok(None)
        }
        // No instruction: a session a client opens on entering a workspace is
        // one the user drives. The issue "Start work" sequence runs in the
        // sidecar and spawns through the control channel instead. On the
        // blocking pool, since a harness's secrets may wait on 1Password.
        "pty_start_claude" => {
            let p: StartClaude = parse(args)?;
            crate::control::validate_workspace_id(&p.workspace_id)
                .map_err(ApiError::bad_request)?;
            blocking(Box::new(move || {
                pty.spawn_claude_session(
                    &p.workspace_id,
                    p.cwd,
                    &p.name,
                    p.remote_control,
                    None,
                    None,
                    p.harness.as_deref(),
                )
                .map_err(ApiError::bad_request)?;
                Ok(None)
            }))
            .await
        }
        _ => Err(ApiError::not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn reads_the_arguments_the_ui_passes_to_invoke() {
        // Shaped like `startClaudeSession` in `src/lib/pty.ts`.
        let p: StartClaude = parse(json!({
            "workspaceId": "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70",
            "cwd": "/w",
            "name": "Fix bug",
            "remoteControl": false,
            "harness": "pi",
        }))
        .unwrap();
        assert_eq!(p.workspace_id, "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70");
        assert_eq!(p.harness.as_deref(), Some("pi"));
        let r: Resize = parse(json!({"id": "tab:terminal/a/b", "cols": 80, "rows": 24})).unwrap();
        assert_eq!((r.cols, r.rows), (80, 24));
        assert!(parse::<Write>(json!({"id": "x"})).is_err());
    }

    #[test]
    fn driving_a_session_needs_chat_and_reading_one_needs_read() {
        assert_eq!(scope_of("pty_write"), Some(Scope::Chat));
        assert_eq!(scope_of("pty_start_claude"), Some(Scope::Chat));
        assert_eq!(scope_of("pty_exists"), Some(Scope::Read));
        assert_eq!(scope_of("get_agent_config"), Some(Scope::Chat));
        // Attaching is the `/api/pty/{id}` WebSocket, not a core command.
        assert_eq!(scope_of("pty_attach"), None);
    }
}
