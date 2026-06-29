//! Pseudo-terminal sessions backing the Terminal widget.
//!
//! Each session owns a real shell spawned through a PTY and lives in the Rust
//! core, independent of the webview component that renders it. The frontend
//! reattaches to a session by a stable id and replays the captured scrollback,
//! so switching tabs or re-rendering an Omni layout does not kill the shell. A
//! reader thread streams output to the frontend as `pty-output:<id>` events and
//! signals teardown with `pty-exit:<id>`, mirroring the event pattern in
//! `alarms.rs`. Events are namespaced per session so each terminal only
//! receives its own output.

use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{Arc, Mutex};

use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};
use tauri::{AppHandle, Emitter};

/// Upper bound on per-session captured output, in bytes. Older output is
/// dropped from the front once exceeded so memory stays bounded.
const MAX_SCROLLBACK: usize = 1024 * 1024;
const READ_BUF_SIZE: usize = 4096;
/// Maximum bytes accepted in a single `pty_write` call. Bounds the amount a
/// compromised webview (e.g. via an XSS that the CSP misses) can shove at the
/// shell in one IPC call. The shell still receives an aggregate of separate
/// writes, so this isn't a strong defense — it's an extra layer.
const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Cap on the number of live PTY sessions. A multi-repo workspace opens a
/// parent terminal plus a run-script session per repo, so several workspaces
/// can be live at once; this still bounds `pty_attach` with novel ids from
/// spawning shells without limit.
const MAX_SESSIONS: usize = 24;

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

fn pty_size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

/// Appends `chunk` to `buf`, dropping the oldest bytes so `buf` never exceeds
/// `max`. Extracted as a free function so the cap logic is unit-testable
/// without a live PTY.
fn append_capped(buf: &mut Vec<u8>, chunk: &[u8], max: usize) {
    buf.extend_from_slice(chunk);
    if buf.len() > max {
        let excess = buf.len() - max;
        buf.drain(0..excess);
    }
}

/// Clones a session's scrollback, treating a poisoned lock as empty rather than
/// propagating — a reader-thread panic must not permanently brick reattach.
fn snapshot(scrollback: &Arc<Mutex<Vec<u8>>>) -> Vec<u8> {
    scrollback.lock().map(|sb| sb.clone()).unwrap_or_default()
}

/// Spawns a shell in a new PTY and starts the reader thread that streams its
/// output to the frontend. The shell opens in `cwd` when given (e.g. a
/// workspace folder), otherwise in `$HOME`.
fn spawn_session(
    app: &AppHandle,
    id: &str,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(cols, rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if let Some(dir) = cwd
        .filter(|d| !d.is_empty())
        .or_else(|| std::env::var("HOME").ok())
    {
        cmd.cwd(dir);
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
    let output_event = format!("pty-output:{id}");
    let mut buf = [0u8; READ_BUF_SIZE];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                let chunk = &buf[..n];
                if let Ok(mut sb) = scrollback.lock() {
                    append_capped(&mut sb, chunk, MAX_SCROLLBACK);
                }
                let _ = app.emit(&output_event, chunk.to_vec());
            }
        }
    }
    // The shell exited or the PTY closed. The dead session is left in the map
    // and reaped lazily on the next attach (see `pty_attach`).
    let _ = app.emit(&format!("pty-exit:{id}"), ());
}

// --- Commands ---

/// Attaches to the session `id`, returning its scrollback to replay. Spawns a
/// fresh shell when the session is absent or its shell has already exited.
#[tauri::command]
pub fn pty_attach(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    id: String,
    cols: u16,
    rows: u16,
    cwd: Option<String>,
) -> Result<Vec<u8>, String> {
    // Reattach to a live session; reap and respawn a dead one.
    {
        let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if let Some(session) = sessions.get_mut(&id) {
            if matches!(session.child.try_wait(), Ok(None)) {
                return Ok(snapshot(&session.scrollback));
            }
            sessions.remove(&id);
        }
    }

    // Enforce the per-process cap before spawning, not after, so a flood of
    // attach calls doesn't briefly hold MAX_SESSIONS+N live shells.
    {
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= MAX_SESSIONS && !sessions.contains_key(&id) {
            return Err(format!(
                "too many PTY sessions (cap: {MAX_SESSIONS}); close one before opening another"
            ));
        }
    }

    // Spawn outside the lock: openpty + spawn_command + thread do real I/O and
    // would otherwise block every other PTY command for the duration.
    let session = spawn_session(&app, &id, cols, rows, cwd)?;

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(existing) = sessions.get(&id) {
        // A concurrent attach for the same id won the race; keep it, discard
        // ours so we don't leak an orphan shell.
        let mut loser = session;
        let _ = loser.child.kill();
        return Ok(snapshot(&existing.scrollback));
    }
    sessions.insert(id, session);
    Ok(Vec::new())
}

#[tauri::command]
pub fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: String,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_WRITE_BYTES {
        return Err(format!("pty_write payload exceeds {MAX_WRITE_BYTES} bytes"));
    }
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

/// True when a non-shell foreground process is running in the PTY (e.g. the user
/// is in vim, tailing logs, or running tests). Compares the PTY's foreground
/// process group to the shell's pid: if they differ, the shell has handed off
/// the foreground to a child. Returns false for unknown sessions or when the
/// platform can't report a process group (Windows, serial PTYs).
#[tauri::command]
pub fn pty_is_busy(state: tauri::State<'_, PtyState>, id: String) -> Result<bool, String> {
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    let Some(session) = sessions.get(&id) else {
        return Ok(false);
    };
    let Some(fg) = session.master.process_group_leader() else {
        return Ok(false);
    };
    let Some(shell_pid) = session.child.process_id() else {
        return Ok(false);
    };
    Ok(fg > 0 && (fg as u32) != shell_pid)
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(mut session) = sessions.remove(&id) {
        // Killing the child closes its PTY end; the reader thread then sees EOF
        // and reports teardown via `pty-exit`. Removing the session drops the
        // master and writer.
        let _ = session.child.kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{append_capped, MAX_SCROLLBACK};

    #[test]
    fn append_capped_leaves_under_cap_untouched() {
        let mut buf = Vec::new();
        append_capped(&mut buf, b"hello", 1024);
        assert_eq!(buf, b"hello");
    }

    #[test]
    fn append_capped_trims_oldest_down_to_cap() {
        let mut buf = Vec::new();
        append_capped(&mut buf, b"0123456789", 10);
        append_capped(&mut buf, b"abcde", 10);
        // The oldest 5 bytes are dropped and the length is held at the cap.
        assert_eq!(buf, b"56789abcde");
    }

    #[test]
    fn append_capped_handles_chunk_larger_than_cap() {
        let mut buf = Vec::new();
        append_capped(&mut buf, b"abcdefghij", 4);
        assert_eq!(buf, b"ghij");
    }

    #[test]
    fn append_capped_real_cap_is_bounded() {
        let mut buf = Vec::new();
        for _ in 0..512 {
            append_capped(&mut buf, &[b'x'; 4096], MAX_SCROLLBACK);
        }
        assert!(buf.len() <= MAX_SCROLLBACK);
    }
}
