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
use tauri::{AppHandle, Emitter, Manager};

use crate::settings::SettingsState;

/// Upper bound on per-session captured output, in bytes. Older output is
/// dropped from the front once exceeded so memory stays bounded.
const MAX_SCROLLBACK: usize = 1024 * 1024;
const READ_BUF_SIZE: usize = 4096;
/// Maximum bytes accepted in a single `pty_write` call. Bounds the amount a
/// compromised webview (e.g. via an XSS that the CSP misses) can shove at the
/// shell in one IPC call. The shell still receives an aggregate of separate
/// writes, so this isn't a strong defense — it's an extra layer.
const MAX_WRITE_BYTES: usize = 64 * 1024;
/// Default cap on the number of live PTY sessions. A multi-repo workspace opens
/// a parent terminal plus a run-script session per repo, so several workspaces
/// can be live at once; this still bounds `pty_attach` with novel ids from
/// spawning shells without limit. Overridable in Settings, which persists the
/// chosen value as `maxPtySessions`.
pub const DEFAULT_MAX_SESSIONS: usize = 60;

/// The configured (or default) cap on live PTY sessions. Read on each use so a
/// change made in Settings applies to the next terminal opened rather than
/// waiting for a restart.
fn max_sessions(app: &AppHandle) -> usize {
    resolve_max_sessions(app.state::<SettingsState>().snapshot().max_pty_sessions)
}

/// Resolves the session cap from the stored setting. Extracted from
/// `max_sessions` so the fallback is unit-testable without app state. An unset
/// or zero setting falls back to the default — a zero cap would make every
/// session unopenable.
fn resolve_max_sessions(configured: Option<usize>) -> usize {
    configured
        .filter(|n| *n > 0)
        .unwrap_or(DEFAULT_MAX_SESSIONS)
}

/// Soft file-descriptor limit aimed for at startup. Each live session holds
/// several descriptors (the PTY master plus the cloned reader and the writer
/// taken from it), so the session cap alone doesn't bound fd use. Chosen with
/// room to spare above what `DEFAULT_MAX_SESSIONS` sessions need, and low
/// enough to stay under the per-process ceiling `setrlimit` enforces.
#[cfg(unix)]
const DESIRED_FD_LIMIT: libc::rlim_t = 4096;

/// Raises the soft file-descriptor limit toward `DESIRED_FD_LIMIT` so the
/// session cap, not the fd budget, is what stops new terminals. A macOS app
/// launched from Finder inherits a soft limit of 256 regardless of the shell's,
/// which several dozen live sessions plus the webview's own descriptors can
/// exhaust — and an `EMFILE` surfaces on whatever opens a descriptor next
/// (control socket, keychain, resource loads) rather than as the session-cap
/// error. Best effort: a failure here leaves the inherited limit in place.
#[cfg(unix)]
pub fn raise_fd_limit() -> Result<(), String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit`/`setrlimit` only read and write the `rlimit` we own.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let Some(target) = target_fd_limit(limit.rlim_cur, limit.rlim_max) else {
        return Ok(());
    };
    limit.rlim_cur = target;
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// The soft limit to raise to, or `None` when the inherited one already suffices
/// and the call can be skipped. Never lowers an existing limit and never exceeds
/// the hard limit, which is what a process without privileges is allowed to ask
/// for. Extracted from `raise_fd_limit` so the arithmetic is unit-testable
/// without touching the process's real limits.
#[cfg(unix)]
fn target_fd_limit(soft: libc::rlim_t, hard: libc::rlim_t) -> Option<libc::rlim_t> {
    // An infinite hard limit imposes no ceiling of its own, so ask for the full
    // desired amount.
    let ceiling = if hard == libc::RLIM_INFINITY {
        DESIRED_FD_LIMIT
    } else {
        hard.min(DESIRED_FD_LIMIT)
    };
    (soft < ceiling).then_some(ceiling)
}

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

/// Parameters for spawning a session, grouped so the spawn helpers stay within
/// a sane argument count.
struct SpawnSpec {
    cols: u16,
    rows: u16,
    cwd: Option<String>,
    /// Typed into the fresh shell to run once on startup (e.g. launching `claude`).
    initial_command: Option<String>,
    /// Drop `ANTHROPIC_API_KEY` from the child env so a Claude Code session uses
    /// the user's subscription login (Remote Control does not support API-key auth).
    strip_provider_secrets: bool,
}

/// Environment a Yarvis-launched Claude session needs so its attention hooks can
/// reach the sidecar's ingest endpoint. Only workspace Claude sessions (keyed
/// `ws-claude:<workspaceId>`) get the token; every other PTY (plain terminals)
/// gets nothing. Pure so the gating is unit-testable without a live PTY.
fn attention_env(id: &str, port: u16, token: &str) -> Vec<(String, String)> {
    let Some(workspace_id) = id.strip_prefix("ws-claude:") else {
        return Vec::new();
    };
    vec![
        ("YARVIS_SIDECAR_PORT".to_string(), port.to_string()),
        ("YARVIS_ATTENTION_TOKEN".to_string(), token.to_string()),
        ("YARVIS_WORKSPACE_ID".to_string(), workspace_id.to_string()),
        ("YARVIS_SESSION_KEY".to_string(), id.to_string()),
    ]
}

/// Spawns a shell in a new PTY and starts the reader thread that streams its
/// output to the frontend. The shell opens in `spec.cwd` when given (e.g. a
/// workspace folder), otherwise in `$HOME`.
fn spawn_session(app: &AppHandle, id: &str, spec: &SpawnSpec) -> Result<PtySession, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(pty_size(spec.cols, spec.rows))
        .map_err(|e| e.to_string())?;

    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let mut cmd = CommandBuilder::new(shell);
    cmd.env("TERM", "xterm-256color");
    if spec.strip_provider_secrets {
        cmd.env_remove("ANTHROPIC_API_KEY");
    }
    // Workspace Claude sessions carry the sidecar port + scoped attention token so
    // their Claude Code hooks can post to the ingest endpoint. Both launch flows
    // (core-spawned and the issue "Start work" shell) route through here.
    if let (Some(info), Some(attn)) = (
        app.try_state::<crate::sidecar::SidecarInfo>(),
        app.try_state::<crate::sidecar::AttentionIngestToken>(),
    ) {
        for (key, value) in attention_env(id, info.port, &attn.0) {
            cmd.env(key, value);
        }
    }
    if let Some(dir) = spec
        .cwd
        .clone()
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
    let mut writer = pair.master.take_writer().map_err(|e| e.to_string())?;

    // Type the startup command into the fresh shell. The PTY buffers it until the
    // shell is ready to read, and its echo lands in the scrollback like any input.
    if let Some(command) = spec.initial_command.as_deref() {
        let _ = writer.write_all(format!("{command}\r").as_bytes());
        let _ = writer.flush();
    }

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

/// Spawns a session and inserts it into `state` under `id`, enforcing the
/// per-process cap and handling a concurrent spawn of the same id. Shared by
/// `pty_attach` (frontend) and the control channel (sidecar), so both create
/// sessions through one path.
fn spawn_into_state(
    app: &AppHandle,
    state: &PtyState,
    id: &str,
    spec: SpawnSpec,
) -> Result<(), String> {
    // Enforce the per-process cap before spawning, not after, so a flood of
    // calls doesn't briefly hold more shells than the cap allows.
    {
        let cap = max_sessions(app);
        let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
        if sessions.len() >= cap && !sessions.contains_key(id) {
            return Err(format!(
                "too many PTY sessions (cap: {cap}); close one before opening another"
            ));
        }
    }

    // Spawn outside the lock: openpty + spawn_command + thread do real I/O and
    // would otherwise block every other PTY command for the duration.
    let session = spawn_session(app, id, &spec)?;

    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if sessions.contains_key(id) {
        // A concurrent spawn for the same id won the race; keep it, discard ours
        // so we don't leak an orphan shell.
        let mut loser = session;
        let _ = loser.child.kill();
        return Ok(());
    }
    sessions.insert(id.to_string(), session);
    Ok(())
}

/// Removes a session and kills its shell. Shared by `pty_kill` and the control
/// channel. No-op when the session is absent.
pub fn kill_session(state: &PtyState, id: &str) {
    if let Ok(mut sessions) = state.sessions.lock() {
        if let Some(mut session) = sessions.remove(id) {
            // Killing the child closes its PTY end; the reader thread then sees
            // EOF and reports teardown via `pty-exit`.
            let _ = session.child.kill();
        }
    }
}

/// Base command used to launch Claude Code. Overridable via the
/// `YARVIS_CLAUDE_COMMAND` env var so a user can bake in default options (e.g. a
/// different permission mode or model). Remote-control sessions append
/// `--remote-control <name>` to whatever this resolves to.
const DEFAULT_CLAUDE_COMMAND: &str = "claude --permission-mode auto";

/// The configured (or default) base command used to start Claude Code. Read from
/// the environment on each use so a restart-injected change is picked up without
/// a rebuild; an empty override falls back to the default.
fn claude_base_command() -> String {
    std::env::var("YARVIS_CLAUDE_COMMAND")
        .ok()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_CLAUDE_COMMAND.to_string())
}

/// Composes the remote-control launch line from a base command and a session
/// name. Extracted from `spawn_claude_session` so the composition is unit-testable
/// without reading the environment or spawning a PTY.
fn remote_control_command(base: &str, name: &str) -> String {
    format!(
        "{} --remote-control {}",
        base.trim(),
        shell_single_quote(name)
    )
}

/// Builds the shell-safe single-quoted form of `s` for injection into a shell
/// command line. Wraps in single quotes and escapes any embedded single quote.
fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

/// Starts a remote-controllable Claude Code session in `cwd` under the stable id
/// `ws-claude:<workspace_id>`, which the frontend later attaches to. The argv is
/// constructed here (not supplied by the caller) so the control channel can only
/// ever launch Claude, never an arbitrary command. Returns once the session is
/// registered; the session keeps running until killed or the app exits.
pub fn spawn_claude_session(
    app: &AppHandle,
    state: &PtyState,
    workspace_id: &str,
    cwd: String,
    name: &str,
) -> Result<(), String> {
    let id = format!("ws-claude:{workspace_id}");
    let command = remote_control_command(&claude_base_command(), name);
    spawn_into_state(
        app,
        state,
        &id,
        SpawnSpec {
            cols: 120,
            rows: 32,
            cwd: Some(cwd),
            initial_command: Some(command),
            strip_provider_secrets: true,
        },
    )
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

    spawn_into_state(
        &app,
        state.inner(),
        &id,
        SpawnSpec {
            cols,
            rows,
            cwd,
            initial_command: None,
            strip_provider_secrets: false,
        },
    )?;

    // Return the scrollback of whatever session now holds the id (a fresh spawn
    // has none; a race winner may already have output).
    let sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    match sessions.get(&id) {
        Some(session) => Ok(snapshot(&session.scrollback)),
        None => Ok(Vec::new()),
    }
}

/// True if a live session (its shell still running) exists for `id`. Lets the
/// frontend tell whether a Claude session is active without spawning one.
#[tauri::command]
pub fn pty_exists(state: tauri::State<'_, PtyState>, id: String) -> Result<bool, String> {
    let mut sessions = state.sessions.lock().map_err(|e| e.to_string())?;
    if let Some(session) = sessions.get_mut(&id) {
        // A dead session is left for lazy reaping on the next attach.
        return Ok(matches!(session.child.try_wait(), Ok(None)));
    }
    Ok(false)
}

/// Starts a remote-controllable Claude session for an existing workspace, so the
/// frontend can offer a "Start Claude session" action. Mirrors what the control
/// channel does for the sidecar/agent; both go through `spawn_claude_session`.
#[tauri::command]
pub fn pty_start_claude(
    app: AppHandle,
    state: tauri::State<'_, PtyState>,
    workspace_id: String,
    cwd: String,
    name: String,
) -> Result<(), String> {
    spawn_claude_session(&app, state.inner(), &workspace_id, cwd, &name)
}

/// Returns the configured base command used to start Claude Code, so the
/// frontend's own Claude launches (e.g. the issue "Start work" terminal) match
/// the command remote-control sessions are built from.
#[tauri::command]
pub fn get_claude_command() -> String {
    claude_base_command()
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
    #[cfg(unix)]
    {
        let Some(fg) = session.master.process_group_leader() else {
            return Ok(false);
        };
        let Some(shell_pid) = session.child.process_id() else {
            return Ok(false);
        };
        Ok(fg > 0 && (fg as u32) != shell_pid)
    }
    #[cfg(not(unix))]
    {
        let _ = session;
        Ok(false)
    }
}

#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: String) -> Result<(), String> {
    kill_session(state.inner(), &id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        append_capped, attention_env, remote_control_command, resolve_max_sessions,
        DEFAULT_MAX_SESSIONS, MAX_SCROLLBACK,
    };

    #[cfg(unix)]
    mod fd_limit {
        use super::super::{target_fd_limit, DESIRED_FD_LIMIT};

        #[test]
        fn raises_a_low_inherited_soft_limit() {
            // The soft limit a macOS app inherits from a Finder launch.
            assert_eq!(target_fd_limit(256, 1 << 20), Some(DESIRED_FD_LIMIT));
        }

        #[test]
        fn stops_at_the_hard_limit() {
            assert_eq!(target_fd_limit(256, 1024), Some(1024));
        }

        #[test]
        fn asks_for_the_full_amount_when_the_hard_limit_is_infinite() {
            assert_eq!(
                target_fd_limit(256, libc::RLIM_INFINITY),
                Some(DESIRED_FD_LIMIT)
            );
        }

        #[test]
        fn skips_a_soft_limit_that_already_suffices() {
            assert_eq!(target_fd_limit(DESIRED_FD_LIMIT, 1 << 20), None);
            assert_eq!(target_fd_limit(1 << 20, 1 << 20), None);
        }

        #[test]
        fn never_lowers_a_soft_limit_above_the_hard_limit() {
            // Nonsensical, but a silent lowering would be worse than a no-op.
            assert_eq!(target_fd_limit(2048, 1024), None);
        }
    }

    #[test]
    fn resolve_max_sessions_uses_the_default_when_unset() {
        assert_eq!(resolve_max_sessions(None), DEFAULT_MAX_SESSIONS);
    }

    #[test]
    fn resolve_max_sessions_uses_a_configured_value() {
        assert_eq!(resolve_max_sessions(Some(120)), 120);
    }

    #[test]
    fn resolve_max_sessions_accepts_the_smallest_usable_value() {
        assert_eq!(resolve_max_sessions(Some(1)), 1);
    }

    #[test]
    fn resolve_max_sessions_falls_back_on_a_zero_cap() {
        assert_eq!(resolve_max_sessions(Some(0)), DEFAULT_MAX_SESSIONS);
    }

    #[test]
    fn remote_control_command_appends_flag_and_quotes_name() {
        let cmd = remote_control_command("claude --permission-mode auto", "Rename the API");
        assert_eq!(
            cmd,
            "claude --permission-mode auto --remote-control 'Rename the API'"
        );
    }

    #[test]
    fn remote_control_command_uses_a_custom_base() {
        let cmd = remote_control_command("claude --model opus --permission-mode plan", "Fix bug");
        assert_eq!(
            cmd,
            "claude --model opus --permission-mode plan --remote-control 'Fix bug'"
        );
    }

    #[test]
    fn remote_control_command_escapes_single_quotes_in_the_name() {
        let cmd = remote_control_command("claude", "Mike's task");
        assert_eq!(cmd, "claude --remote-control 'Mike'\\''s task'");
    }

    #[test]
    fn attention_env_populates_workspace_claude_sessions() {
        let env = attention_env("ws-claude:abc-123", 8765, "tok");
        assert_eq!(
            env,
            vec![
                ("YARVIS_SIDECAR_PORT".to_string(), "8765".to_string()),
                ("YARVIS_ATTENTION_TOKEN".to_string(), "tok".to_string()),
                ("YARVIS_WORKSPACE_ID".to_string(), "abc-123".to_string()),
                (
                    "YARVIS_SESSION_KEY".to_string(),
                    "ws-claude:abc-123".to_string()
                ),
            ]
        );
    }

    #[test]
    fn attention_env_is_empty_for_non_claude_sessions() {
        // A plain terminal PTY must not receive the ingest token.
        assert!(attention_env("tab:terminal/abc/def", 8765, "tok").is_empty());
    }

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
