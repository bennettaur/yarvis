//! Local control channel: a Unix-domain-socket RPC the Bun sidecar uses to ask
//! the server to do things it can't do itself: spawning, killing, and typing
//! an instruction or an allowed slash command into a Claude Code session in a
//! workspace PTY, writing an MCP server's OAuth credentials or a signed-in
//! GitHub token into the secrets blob, and ringing an alarm the sidecar found
//! due (`alarm.fire`) or stopping one (`alarm.release`). It also starts and
//! ends the locked-down session over a review workspace's PR checkouts
//! (`claude.spawnReview`, `claude.killReview`), and hands a Claude Code
//! harness's program and environment to a verification run (`harness.runEnv`).
//!
//! Security model: the socket lives in the server's private data dir (mode
//! 0700), or in a private short directory when that path is too long to bind
//! (`socket_dir`), as a mode-0600 file, so only the same user can connect, and
//! a UDS is never reachable over the network. The protocol is deliberately narrow: the
//! sidecar can only start, stop, or talk to an agent session for a workspace,
//! and chooses only whether to launch one and which saved harness, by id,
//! never what runs. The command comes from settings, which only an admin
//! device can write, and a harness is refused unless the user allowed the
//! assistant to start it. The sidecar's `name` does reach the launch line, and
//! that line is typed into an interactive shell rather than exec'd, so
//! `sanitize_session_name` strips it; see that function for why quoting alone
//! is not enough. `claude.send` types free text at a prompt instead, which
//! [`PtyManager::send_session_instruction`] sanitizes, refuses to send unless
//! the session's own agent is what reads that prompt, and refuses outright
//! when it opens with a character the agent reads as a command rather than a
//! request. `claude.slash` is how a slash command reaches a session: the
//! sidecar names a command, and [`PtyManager::send_session_slash_command`]
//! types it only when it is on the allowlist (built-in defaults plus a list
//! the user keeps in Settings, which no sidecar route or tool writes). Its
//! arguments are cleaned like an instruction. `mcp.saveOAuth` and
//! `github.saveToken` are the two methods that write a secret. `mcp.saveOAuth`
//! can only reach the `oauth` subtree of one MCP server's entry, and
//! `github.saveToken` only the `github_token` key, never a provider key, the
//! database URL, or another server's headers. `harness.runEnv` is the one
//! method that reads a secret back: it answers with one Claude Code harness's
//! program and environment, that harness's secret variables included, for a
//! headless verification run the sidecar starts with it. It refuses any other
//! kind, and never answers with another harness's values or anything else in
//! the store. Like every method here it trusts any process running as the
//! user, so such a process can read a Claude Code harness's secrets through
//! it; that was accepted rather than tying the socket to the sidecar's pid.
//!
//! The alarm methods don't ring anything here: they append `alarm.fire` and
//! `alarm.release` to the event log, and each client decides how to show
//! them. Requests and responses are newline-delimited JSON; a reply carries
//! `result` only for a method that answers with data.
//!
//! [`PtyManager::send_session_instruction`]: crate::pty::PtyManager::send_session_instruction
//! [`PtyManager::send_session_slash_command`]: crate::pty::PtyManager::send_session_slash_command

use serde::{Deserialize, Serialize};

/// The socket's file name. It goes where [`crate::socket_dir::socket_path`]
/// says, and the sidecar gets the full path as `YARVIS_CORE_SOCK`.
pub const SOCKET_FILE: &str = "core-control.sock";

/// Workspace ids are UUIDs; reject anything else so the value can't smuggle a
/// surprising character into the session key.
pub fn validate_workspace_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("invalid workspaceId".into())
    }
}

/// An alarm as the sidecar sends it (`toAlarm()` in
/// `sidecar/src/alarms/service.ts`) and clients' takeovers read it.
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Alarm {
    pub id: String,
    pub label: String,
    pub fire_at_ms: i64,
    #[serde(default = "default_true")]
    pub sound: bool,
    /// Join URL for a meeting-derived alarm, so the takeover can offer a
    /// "Join meeting" action. Absent for manually created alarms.
    #[serde(default)]
    pub meet_link: Option<String>,
    /// "scheduled" | "fired" | "acknowledged" | "cancelled"
    pub status: String,
}

fn default_true() -> bool {
    true
}

/// Alarm ids are UUIDs too; the same bound keeps a junk id out of every
/// client's ringing state.
fn validate_alarm_id(id: &str) -> Result<(), String> {
    validate_workspace_id(id).map_err(|_| "invalid alarm id".to_string())
}

/// The longest label the takeover and notification show; past it, cut.
const MAX_ALARM_LABEL_CHARS: usize = 500;

/// An alarm to ring is checked like any input from the socket: a UUID id, a
/// label short enough for a notification, and only a web link behind the
/// takeover's Join button.
fn check_alarm(alarm: &mut Alarm) -> Result<(), String> {
    validate_alarm_id(&alarm.id)?;
    if let Some(link) = &alarm.meet_link {
        let lower = link.to_ascii_lowercase();
        if !(lower.starts_with("https://") || lower.starts_with("http://")) {
            return Err("meetLink must be an http(s) link".into());
        }
    }
    if alarm.label.chars().count() > MAX_ALARM_LABEL_CHARS {
        alarm.label = alarm.label.chars().take(MAX_ALARM_LABEL_CHARS).collect();
    }
    Ok(())
}

#[cfg(unix)]
pub use unix_impl::start;

#[cfg(unix)]
mod unix_impl {
    use std::collections::BTreeMap;
    use std::path::{Path, PathBuf};

    use serde::{Deserialize, Serialize};
    use serde_json::Value;
    use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
    use tokio::net::{UnixListener, UnixStream};

    use super::{Alarm, SOCKET_FILE, check_alarm, validate_alarm_id, validate_workspace_id};
    use crate::AppState;
    use crate::pty::{PtyManager, review_session_id};
    use crate::socket_dir;

    /// Cap on a single request line, bounding what one message can buffer.
    const MAX_LINE: usize = 64 * 1024;

    #[derive(Deserialize)]
    pub(super) struct Request {
        #[serde(default)]
        pub(super) id: Value,
        pub(super) method: String,
        #[serde(default)]
        pub(super) params: Value,
    }

    #[derive(Serialize)]
    pub(super) struct Response {
        pub(super) id: Value,
        pub(super) ok: bool,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) result: Option<Value>,
        #[serde(skip_serializing_if = "Option::is_none")]
        pub(super) error: Option<String>,
    }

    #[derive(Deserialize)]
    pub(super) struct SpawnParams {
        #[serde(rename = "workspaceId")]
        pub(super) workspace_id: String,
        pub(super) cwd: String,
        pub(super) name: String,
        /// Whether to launch with Remote Control. Absent means off, so a caller
        /// that hasn't been taught about it can't silently opt in.
        #[serde(rename = "remoteControl", default)]
        pub(super) remote_control: bool,
        /// What the session should start on, appended to the launch line as one
        /// quoted argument. Set by the issue "Start work" sequence, which the
        /// sidecar drives end to end; absent means a session the user drives.
        #[serde(default)]
        pub(super) instruction: Option<String>,
        /// A Claude Code session id to continue with `--resume`, set when the
        /// sidecar relaunches a workspace's agent after a restart.
        #[serde(default)]
        pub(super) resume: Option<String>,
        /// Id of the agent harness to launch. Absent means the configured
        /// default. The server resolves it against the harnesses the user
        /// saved, so a caller picks among those and never supplies a command.
        #[serde(default)]
        pub(super) harness: Option<String>,
    }

    /// Parses a `claude.spawn` request, validates its workspace id and runs the
    /// assistant-harness gate on it. `gate` gets the harness asked for and
    /// whether this is a resume. Parsing and the gate sit together so the
    /// dispatch has no way to get spawn parameters without running it.
    pub(super) fn checked_spawn_params(
        params: Value,
        gate: impl FnOnce(Option<&str>, bool) -> Result<(), String>,
    ) -> Result<SpawnParams, String> {
        let p: SpawnParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        validate_workspace_id(&p.workspace_id)?;
        gate(p.harness.as_deref(), p.resume.is_some())?;
        Ok(p)
    }

    #[derive(Deserialize)]
    pub(super) struct SpawnReviewParams {
        #[serde(rename = "workspaceId")]
        pub(super) workspace_id: String,
        pub(super) cwd: String,
        /// The PR checkouts the session reads, added as
        /// `permissions.additionalDirectories`.
        #[serde(rename = "addDirs")]
        pub(super) add_dirs: Vec<String>,
        /// The session's settings as JSON text, written to the file `--settings` reads.
        pub(super) settings: String,
        /// Which PR is checked out where, appended to the session's guardrail.
        pub(super) context: String,
        /// Whether the user chose to load the repos' own skills and CLAUDE.md.
        #[serde(rename = "loadRepoConfig", default)]
        pub(super) load_repo_config: bool,
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
        /// model, so `send_session_instruction` sanitizes and bounds it.
        instruction: String,
        /// Agent processes registered for the session by its SessionStart hook.
        /// Defaults to empty, which leaves only the executable-name check.
        #[serde(default, rename = "agentPids")]
        agent_pids: Vec<u32>,
    }

    #[derive(Deserialize)]
    pub(super) struct SlashParams {
        #[serde(rename = "workspaceId")]
        pub(super) workspace_id: String,
        /// The command's name, with or without its `/`. Checked against the
        /// allowlist in `send_session_slash_command`.
        pub(super) command: String,
        /// Text after the command. Composed by the chat model, so it is cleaned
        /// like an instruction before it is typed.
        #[serde(default)]
        pub(super) arguments: Option<String>,
        #[serde(default, rename = "agentPids")]
        pub(super) agent_pids: Vec<u32>,
    }

    #[derive(Deserialize)]
    struct SaveOAuthParams {
        #[serde(rename = "serverId")]
        server_id: String,
        /// The credential bundle to store; null forgets what is stored.
        #[serde(default)]
        oauth: Option<Value>,
    }

    #[derive(Deserialize)]
    struct SaveGitHubTokenParams {
        token: String,
    }

    #[derive(Deserialize)]
    pub(super) struct HarnessRunEnvParams {
        pub(super) harness: String,
    }

    #[derive(Deserialize)]
    pub(super) struct FireAlarmParams {
        pub(super) alarm: Alarm,
    }

    #[derive(Deserialize)]
    struct ReleaseAlarmParams {
        id: String,
    }

    /// Binds the control socket and starts serving it. Returns the socket's
    /// path, which the sidecar needs in its env, so call this before starting
    /// the sidecar.
    pub async fn start(state: AppState) -> Result<PathBuf, String> {
        let data_dir = &state.config.server.data_dir;
        std::fs::create_dir_all(data_dir).map_err(|e| e.to_string())?;
        // Who can connect is decided by the directory's permissions alone, so
        // the socket isn't served when they can't be set.
        set_private(data_dir, 0o700)?;
        let path = socket_dir::socket_path(data_dir, SOCKET_FILE);
        socket_dir::prepare(data_dir, &path)?;
        // Clear a stale socket from a previous run, but only if it really is a
        // socket, so a symlink is never followed or a planted file clobbered.
        remove_stale_socket(&path)?;
        let listener = UnixListener::bind(&path).map_err(|e| format!("bind failed: {e}"))?;
        set_private(&path, 0o600)?;
        tokio::spawn(accept_loop(state, listener));
        Ok(path)
    }

    async fn accept_loop(state: AppState, listener: UnixListener) {
        loop {
            match listener.accept().await {
                Ok((stream, _addr)) => {
                    let state = state.clone();
                    tokio::spawn(async move {
                        if let Err(e) = handle_conn(state, stream).await {
                            tracing::warn!("control connection error: {e}");
                        }
                    });
                }
                Err(e) => {
                    tracing::error!("control accept failed: {e}");
                    // Brief backoff so a broken listener doesn't spin a hot loop.
                    tokio::time::sleep(std::time::Duration::from_millis(200)).await;
                }
            }
        }
    }

    async fn handle_conn(state: AppState, stream: UnixStream) -> Result<(), String> {
        let (read_half, mut write_half) = stream.into_split();
        // `take` bounds the read itself, so a peer that never sends a newline
        // can't make the server buffer without limit.
        let mut reader = BufReader::new(read_half);
        let mut line = String::new();
        loop {
            line.clear();
            let n = (&mut reader)
                .take(MAX_LINE as u64 + 1)
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
            let resp = dispatch(&state, trimmed).await;
            let mut out = serde_json::to_string(&resp).map_err(|e| e.to_string())?;
            out.push('\n');
            write_half
                .write_all(out.as_bytes())
                .await
                .map_err(|e| e.to_string())?;
        }
        Ok(())
    }

    pub(super) async fn dispatch(state: &AppState, line: &str) -> Response {
        let req: Request = match serde_json::from_str(line) {
            Ok(r) => r,
            Err(e) => {
                return Response {
                    id: Value::Null,
                    ok: false,
                    result: None,
                    error: Some(format!("bad request: {e}")),
                };
            }
        };
        let outcome = match req.method.as_str() {
            "alarm.fire" => fire_alarm(state, req.params).await.map(|()| None),
            "alarm.release" => release_alarm(state, req.params).await.map(|()| None),
            // Everything else can wait on the secrets write lock, a store
            // prompt, or a PTY, none of which may stall the async runtime.
            method => {
                let method = method.to_string();
                let pty = state.pty.clone();
                tokio::task::spawn_blocking(move || run_blocking(&pty, &method, req.params))
                    .await
                    .unwrap_or_else(|e| Err(e.to_string()))
            }
        };
        match outcome {
            Ok(result) => Response {
                id: req.id,
                ok: true,
                result,
                error: None,
            },
            Err(e) => Response {
                id: req.id,
                ok: false,
                result: None,
                error: Some(e),
            },
        }
    }

    async fn fire_alarm(state: &AppState, params: Value) -> Result<(), String> {
        let mut p: FireAlarmParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        check_alarm(&mut p.alarm)?;
        // Clients raise their takeover straight off this, so the sidecar must
        // have marked the alarm fired before asking.
        let data = serde_json::to_value(&p.alarm).map_err(|e| e.to_string())?;
        state
            .events
            .append(None, "alarm.fire", data)
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    async fn release_alarm(state: &AppState, params: Value) -> Result<(), String> {
        let p: ReleaseAlarmParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        validate_alarm_id(&p.id)?;
        state
            .events
            .append(None, "alarm.release", serde_json::json!({ "id": p.id }))
            .await
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// The methods that run on the blocking pool. `harness.runEnv` is the one
    /// that answers with data.
    fn run_blocking(
        pty: &PtyManager,
        method: &str,
        params: Value,
    ) -> Result<Option<Value>, String> {
        match method {
            "harness.runEnv" => harness_run_env(pty, params).map(Some),
            "claude.spawn" => {
                // The UI's own launches don't come through here, so this is
                // where a harness the assistant chose is checked.
                let p = checked_spawn_params(params, |requested, resuming| {
                    pty.check_sidecar_harness(requested, resuming)
                })?;
                pty.spawn_claude_session(
                    &p.workspace_id,
                    p.cwd,
                    &p.name,
                    p.remote_control,
                    p.resume.as_deref(),
                    p.instruction.as_deref(),
                    p.harness.as_deref(),
                )
                .map(|()| None)
            }
            "claude.spawnReview" => {
                let p: SpawnReviewParams =
                    serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                pty.spawn_review_claude_session(
                    &p.workspace_id,
                    p.cwd,
                    &p.add_dirs,
                    &p.settings,
                    &p.context,
                    p.load_repo_config,
                )
                .map(|()| None)
            }
            "claude.killReview" => {
                let p: KillParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                pty.kill(&review_session_id(&p.workspace_id));
                Ok(None)
            }
            "claude.kill" => {
                let p: KillParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                pty.kill(&format!("ws-claude:{}", p.workspace_id));
                Ok(None)
            }
            "claude.send" => {
                let p: SendParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                pty.send_session_instruction(&p.workspace_id, &p.instruction, &p.agent_pids)
                    .map(|()| None)
            }
            "claude.slash" => {
                let p: SlashParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
                validate_workspace_id(&p.workspace_id)?;
                pty.send_session_slash_command(
                    &p.workspace_id,
                    &p.command,
                    p.arguments.as_deref(),
                    &p.agent_pids,
                )
                .map(|()| None)
            }
            "mcp.saveOAuth" => {
                let p: SaveOAuthParams =
                    serde_json::from_value(params).map_err(|e| e.to_string())?;
                crate::mcp::store_oauth(pty.secrets(), &p.server_id, p.oauth).map(|()| None)
            }
            "github.saveToken" => {
                let p: SaveGitHubTokenParams =
                    serde_json::from_value(params).map_err(|e| e.to_string())?;
                pty.secrets().store_github_token(&p.token).map(|()| None)
            }
            other => Err(format!("unknown method: {other}")),
        }
    }

    /// `harness.runEnv`: see the module doc for what it may answer with.
    fn harness_run_env(pty: &PtyManager, params: Value) -> Result<Value, String> {
        let p: HarnessRunEnvParams = serde_json::from_value(params).map_err(|e| e.to_string())?;
        // `resolve` reads a blank id as "the default", which this method never means.
        if !crate::harness::is_valid_id(&p.harness) {
            return Err("invalid harness id".into());
        }
        let (program, env) = pty.headless_harness(&p.harness)?;
        Ok(run_env_reply(program, env))
    }

    /// The shape `harnessRunEnvSchema` in `sidecar/src/core/controlClient.ts` reads.
    pub(super) fn run_env_reply(program: String, env: Vec<(String, String)>) -> Value {
        serde_json::json!({
            "program": program,
            "env": env.into_iter().collect::<BTreeMap<_, _>>(),
        })
    }

    fn set_private(path: &Path, mode: u32) -> Result<(), String> {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
            .map_err(|e| format!("couldn't make {} private: {e}", path.display()))
    }

    pub(super) fn remove_stale_socket(path: &Path) -> Result<(), String> {
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

#[cfg(all(test, unix))]
mod tests {
    use super::unix_impl::*;
    use super::*;
    use crate::harness::{self, AgentHarness, HarnessKind};
    use serde_json::{Value, json};

    #[test]
    fn a_spawn_naming_a_harness_the_assistant_may_not_start_is_refused() {
        let yolo = AgentHarness {
            id: "yolo".into(),
            name: "Yolo".into(),
            kind: HarnessKind::ClaudeCode,
            command: "claude --dangerously-skip-permissions".into(),
            ..AgentHarness::default()
        };
        let gate = |params: Value| {
            checked_spawn_params(params, |requested, resuming| {
                harness::check_assistant_may_launch(
                    harness::builtin("Claude".into(), "claude".into()),
                    std::slice::from_ref(&yolo),
                    None,
                    requested,
                    resuming,
                )
            })
            .map(|_| ())
        };
        let base = json!({ "workspaceId": "w", "cwd": "/tmp", "name": "n" });
        assert!(gate(base.clone()).is_ok());
        let mut fresh = base.clone();
        fresh["harness"] = json!("yolo");
        assert!(gate(fresh.clone()).is_err());
        // A resume relaunches what the server already launched there.
        fresh["resume"] = json!("0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70");
        assert!(gate(fresh).is_ok());
        // The workspace id is checked before the gate runs.
        let mut junk = base;
        junk["workspaceId"] = json!("../etc");
        assert!(gate(junk).is_err());
    }

    /// Shaped exactly like `toAlarm()` in `sidecar/src/alarms/service.ts`.
    fn sidecar_payload(meet_link: Value, label: &str) -> Value {
        json!({
            "alarm": {
                "id": "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b",
                "label": label,
                "fireAtMs": 1_760_000_000_000_i64,
                "sound": true,
                "meetLink": meet_link,
                "status": "fired",
                "source": "heads-down",
            }
        })
    }

    /// Shaped like `harnessRunEnv` in `controlClient.ts`, and answered in
    /// the shape it parses.
    #[test]
    fn reads_the_harness_the_sidecar_asks_for_and_answers_its_run_env() {
        let p: HarnessRunEnvParams =
            serde_json::from_value(json!({ "harness": "bedrock" })).expect("sidecar payload");
        assert_eq!(p.harness, "bedrock");
        let reply = run_env_reply(
            "/opt/bin/claude".into(),
            vec![("API_KEY".into(), "sk".into())],
        );
        assert_eq!(
            reply,
            json!({ "program": "/opt/bin/claude", "env": { "API_KEY": "sk" } })
        );
    }

    #[test]
    fn a_reply_carries_result_only_when_a_method_answers_with_data() {
        let plain = Response {
            id: json!(1),
            ok: true,
            result: None,
            error: None,
        };
        assert_eq!(
            serde_json::to_value(plain).unwrap(),
            json!({ "id": 1, "ok": true })
        );
    }

    #[test]
    fn reads_the_alarm_the_sidecar_sends() {
        let mut p: FireAlarmParams = serde_json::from_value(sidecar_payload(
            json!("https://meet.google.com/abc"),
            "Meeting: Standup",
        ))
        .expect("sidecar payload");
        check_alarm(&mut p.alarm).expect("valid alarm");
        assert_eq!(p.alarm.label, "Meeting: Standup");
        assert_eq!(p.alarm.fire_at_ms, 1_760_000_000_000);
        assert_eq!(
            p.alarm.meet_link.as_deref(),
            Some("https://meet.google.com/abc")
        );
    }

    /// Shaped like `spawnClaudeSession` in `sidecar/src/core/controlClient.ts`.
    #[test]
    fn reads_the_resume_id_the_sidecar_sends() {
        let p: SpawnParams = serde_json::from_value(json!({
            "workspaceId": "w1",
            "cwd": "/tmp/ws",
            "name": "ws",
            "remoteControl": false,
            "resume": "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70",
        }))
        .expect("sidecar payload");
        assert_eq!(
            p.resume.as_deref(),
            Some("0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70")
        );
    }

    #[test]
    fn reads_the_review_session_the_sidecar_sends() {
        // Shaped like `spawnReviewClaudeSession` in `controlClient.ts`.
        let p: SpawnReviewParams = serde_json::from_value(json!({
            "workspaceId": "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70",
            "cwd": "/tmp/.review-sessions/w",
            "addDirs": ["/tmp/.review/w/pr1", "/tmp/.review/w/pr2"],
            "settings": "{\"disableAllHooks\":true}",
            "context": "github/o/r/1 in /tmp/.review/w/pr1.",
            "loadRepoConfig": true,
        }))
        .expect("sidecar payload");
        assert!(p.load_repo_config);
        assert!(validate_workspace_id(&p.workspace_id).is_ok());
        assert_eq!(p.add_dirs.len(), 2);
        assert_eq!(p.settings, r#"{"disableAllHooks":true}"#);
        assert!(p.context.starts_with("github/o/r/1"));
    }

    #[test]
    fn reads_the_slash_command_the_sidecar_sends() {
        let p: SlashParams = serde_json::from_value(json!({
            "workspaceId": "w1",
            "command": "compact",
            "arguments": "focus on the tests",
            "agentPids": [42],
        }))
        .expect("sidecar payload");
        assert_eq!(p.workspace_id, "w1");
        assert_eq!(p.command, "compact");
        assert_eq!(p.arguments.as_deref(), Some("focus on the tests"));
        assert_eq!(p.agent_pids, vec![42]);

        let bare: SlashParams =
            serde_json::from_value(json!({ "workspaceId": "w1", "command": "compact" }))
                .expect("payload without arguments");
        assert_eq!(bare.arguments, None);
        assert!(bare.agent_pids.is_empty());
    }

    #[test]
    fn refuses_a_join_link_that_isnt_a_web_link() {
        let mut p: FireAlarmParams =
            serde_json::from_value(sidecar_payload(json!("file:///etc/passwd"), "x"))
                .expect("sidecar payload");
        assert!(check_alarm(&mut p.alarm).is_err());
    }

    #[test]
    fn cuts_a_long_label() {
        let mut p: FireAlarmParams =
            serde_json::from_value(sidecar_payload(Value::Null, &"é".repeat(2_000)))
                .expect("sidecar payload");
        check_alarm(&mut p.alarm).expect("valid alarm");
        assert_eq!(p.alarm.label.chars().count(), MAX_ALARM_LABEL_CHARS);
    }

    #[test]
    fn refuses_a_junk_alarm_id() {
        assert!(validate_alarm_id("").is_err());
        assert!(validate_alarm_id("../../etc").is_err());
        assert!(validate_alarm_id(&"a".repeat(65)).is_err());
        assert!(validate_alarm_id("0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b").is_ok());
    }

    #[test]
    fn a_stale_socket_is_cleared_but_a_planted_file_is_not() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("s.sock");
        remove_stale_socket(&path).unwrap();
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        drop(listener);
        remove_stale_socket(&path).unwrap();
        assert!(!path.exists());
        std::fs::write(&path, "x").unwrap();
        assert!(remove_stale_socket(&path).is_err());
        assert!(path.exists());
    }
}
