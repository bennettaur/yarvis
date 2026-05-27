//! Pseudo-terminal sessions backing the Terminal widget.
//!
//! Each session owns a real shell spawned through a PTY and lives in the Rust
//! core, independent of the webview component that renders it. The frontend
//! reattaches to a session by a stable id and replays the captured scrollback,
//! so switching tabs or re-rendering an Omni layout does not kill the shell. A
//! reader thread streams output to the frontend as `pty-output` events and
//! signals teardown with `pty-exit`, mirroring the event pattern in `alarms.rs`.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

/// Upper bound on per-session captured output, in bytes. Older output is
/// dropped from the front once exceeded so memory stays bounded.
const MAX_SCROLLBACK: usize = 1024 * 1024;
const READ_BUF_SIZE: usize = 4096;

struct PtySession {
    /// Writes user input into the PTY (taken once from the master).
    writer: Box<dyn Write + Send>,
    /// Retained for resize; the reader is cloned off it at spawn time.
    master: Box<dyn MasterPty + Send>,
    child: Box<dyn Child + Send + Sync>,
    /// Output captured so a reattaching component can replay it.
    scrollback: Arc<Mutex<Vec<u8>>>,
}

#[derive(Default)]
pub struct PtyState {
    sessions: Mutex<HashMap<String, PtySession>>,
}

/// Output chunk pushed to the frontend. Bytes are sent raw (a JS `number[]`)
/// rather than as a UTF-8 string, so multibyte sequences split across reads are
/// reassembled by xterm instead of being corrupted by lossy decoding.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyOutput {
    id: String,
    bytes: Vec<u8>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PtyExit {
    id: String,
}

/// Result of attaching to a session: whether it already existed and, if so, the
/// scrollback to replay into a fresh terminal view.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PtyAttach {
    existed: bool,
    scrollback: Vec<u8>,
}

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Spawns a shell in a new PTY and starts the reader thread that streams its
/// output to the frontend.
fn spawn_session(
    app: &AppHandle,
    id: &str,
    cols: u16,
    rows: u16,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Ok(home) = std::env::var("HOME") {
        cmd.cwd(home);
    }

    let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;
    // The parent does not need the slave once the child holds it; closing it
    // here lets the reader see EOF when the shell exits.
    drop(pair.slave);

    let reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    let scrollback = Arc::new(Mutex::new(Vec::<u8>::new()));
    {
        let app = app.clone();
        let id = id.to_string();
        let scrollback = scrollback.clone();
        // PTY reads block, so this lives on a dedicated OS thread rather than
        // the async runtime.
        std::thread::spawn(move || read_loop(app, id, reader, scrollback));
    }

    Ok(PtySession {
        writer,
        master: pair.master,
        child,
        scrollback,
    })
}

fn read_loop(
    app: AppHandle,
    id: String,
    mut reader: Box<dyn Read + Send>,
    scrollback: Arc<Mutex<Vec<u8>>>,
) {
    let mut buf = [0u8; READ_BUF_SIZE];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                if let Ok(mut sb) = scrollback.lock() {
                    sb.extend_from_slice(&chunk);
                    if sb.len() > MAX_SCROLLBACK {
                        let excess = sb.len() - MAX_SCROLLBACK;
                        sb.drain(0..excess);
                    }
                }
                let _ = app.emit(
                    "pty-output",
                    PtyOutput {
                        id: id.clone(),
                        bytes: chunk,
                    },
                );
            }
        }
    }
    let _ = app.emit("pty-exit", PtyExit { id });
}

// --- Commands ---

/// Attaches to the session `id`, creating it if it does not yet exist. Returns
/// the scrollback to replay for an existing session, or empty for a new one.
#[tauri::command]
pub fn pty_attach(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<PtyAttach, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get(&id) {
        let scrollback = session
            .scrollback
            .lock()
            .map_err(|e| e.to_string())?
            .clone();
        return Ok(PtyAttach {
            existed: true,
            scrollback,
        });
    }
    let session = spawn_session(&app, &id, cols, rows)?;
    sessions.insert(id, session);
    Ok(PtyAttach {
        existed: false,
        scrollback: Vec::new(),
    })
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get_mut(&id).ok_or("no such session")?;
    session
        .writer
        .write_all(data.as_bytes())
        .map_err(|e| e.to_string())?;
    session.writer.flush().map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let session = sessions.get(&id).ok_or("no such session")?;
    session
        .master
        .resize(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        // Dropping the session closes the master, which the reader thread sees
        // as EOF and reports via `pty-exit`.
        let _ = session.child.kill();
    }
    Ok(())
}
