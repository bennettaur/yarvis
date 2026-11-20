//! PTY sessions: the Terminal tab's shells and each workspace's agent session.
//!
//! Each session owns a real shell spawned through a PTY and lives in the
//! server, independent of any client. Clients attach by a stable id over
//! `/api/pty/{id}` ([`ws`]) and get the scrollback plus every byte after it,
//! so switching tabs, reloading the page, or watching from a second device
//! doesn't touch the shell. The sidecar reaches sessions only through the
//! control channel ([`crate::control`]), which types into them through
//! [`PtyManager::send_session_instruction`] and
//! [`PtyManager::send_session_slash_command`].
//!
//! Everything here blocks (opening a PTY, reading the secrets store), so async
//! callers go through `spawn_blocking`.

pub mod core;
mod env;
mod guards;
pub mod process;
mod review;
pub mod session;
pub mod ws;

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::Duration;

use portable_pty::{CommandBuilder, native_pty_system};
use serde::Serialize;

use crate::agent_policy::{
    agent_command_env, merge_allowed_slash_commands, resolve_agent_command, resolve_agent_name,
    resolve_max_sessions,
};
use crate::config::SshAgentConfig;
use crate::events::EventLog;
use crate::harness::{self, HarnessSummary, ResolvedHarness};
use crate::secret_blob::SecretBlob;
use crate::settings::SettingsStore;

pub use env::SidecarSessionEnv;
use env::{harness_token, session_env, ssh_auth_sock};
use guards::{
    agent_launch_command, check_remote_control, check_resume, prepare_instruction,
    prepare_slash_command,
};
pub use review::review_session_id;
use review::{
    REVIEW_PROMPT_FILE, REVIEW_SESSION_GUARDRAIL, REVIEW_SESSION_REPO_CONFIG_NOTE,
    REVIEW_SETTINGS_FILE, check_review_spawn, exec_claude_program, refuse_plain_review_shell,
    review_files_dir, review_launch_command, review_settings_with_dirs, write_review_file,
};
use session::{Limits, Session, Size, Start, lock};

/// Upper bound on per-session captured output, in bytes. Older output is
/// dropped from the front once exceeded so memory stays bounded.
pub const MAX_SCROLLBACK: usize = 1024 * 1024;

/// Most bytes one write may carry. Bounds what a single request or message
/// can shove at a shell. A client can still send many, so this is an extra
/// layer, not a defense on its own.
pub const MAX_WRITE_BYTES: usize = 64 * 1024;

/// Events queued per attached client before it is resynced from scrollback.
const CLIENT_QUEUE: usize = 256;

/// How long to wait between typing an instruction and pressing Enter. Claude
/// Code reads text that arrives in one burst as a paste, and a carriage return
/// inside a paste becomes a newline in the prompt rather than a submit. The
/// pause lets the paste settle so the Enter arrives as its own keypress. The
/// value is a margin chosen by hand, not a measured threshold.
const INSTRUCTION_SUBMIT_DELAY: Duration = Duration::from_millis(250);

/// Variable carrying an agent session's harness id into its shell.
const AGENT_HARNESS_ENV: &str = "YARVIS_AGENT_HARNESS";
/// Variable carrying `harness_token` for that id.
const AGENT_HARNESS_TOKEN_ENV: &str = "YARVIS_AGENT_HARNESS_TOKEN";

/// Which harness an agent session runs, kept for as long as the session lives
/// so a later check judges it against what was launched there rather than
/// whatever the default has since become.
#[derive(Clone)]
pub struct SessionAgent {
    harness_id: String,
    harness_name: String,
    /// The launch command's program; what the foreground check compares
    /// against when no registered pid matches.
    program: Option<String>,
}

/// Parameters for spawning a session.
struct SpawnSpec {
    size: Size,
    cwd: Option<String>,
    /// Typed into the fresh shell to run once on startup (e.g. launching `claude`).
    initial_command: Option<String>,
    /// Drop `ANTHROPIC_API_KEY` from the inherited env so a Claude Code session
    /// uses the user's subscription login (Remote Control does not support
    /// API-key auth). A harness that sets the key itself still gets it: its
    /// variables are applied after the strip.
    strip_provider_secrets: bool,
    /// The harness an agent session runs and the environment it adds. `None`
    /// for a plain terminal.
    agent: Option<SpawnAgent>,
    /// Stream offset the new session's capture starts counting from. Non-zero
    /// only when this spawn replaces a dead session under the same id, so a
    /// client resuming from the dead session's last offset carries on into
    /// the new one rather than being told it lost bytes.
    start_offset: u64,
}

/// What an agent session's spawn needs from its harness.
struct SpawnAgent {
    identity: SessionAgent,
    /// The harness's plain and secret variables. Set before the server's
    /// session variables, so a harness variable can't override them.
    env: Vec<(String, String)>,
}

/// Knobs tests turn; the defaults are what the server runs with.
#[derive(Clone, Debug)]
pub struct PtyOptions {
    /// The shell every session runs. `None` means `$SHELL`, else `/bin/zsh`.
    pub shell: Option<String>,
    pub scrollback_cap: usize,
    pub client_queue: usize,
    /// How long one WebSocket send may block before the client is dropped.
    pub send_timeout: Duration,
    /// The pause between an agent send's text and its Enter. See
    /// [`INSTRUCTION_SUBMIT_DELAY`].
    pub submit_delay: Duration,
}

impl Default for PtyOptions {
    fn default() -> Self {
        Self {
            shell: None,
            scrollback_cap: MAX_SCROLLBACK,
            client_queue: CLIENT_QUEUE,
            send_timeout: Duration::from_secs(10),
            submit_delay: INSTRUCTION_SUBMIT_DELAY,
        }
    }
}

/// Every PTY session, and what spawning one needs.
#[derive(Clone)]
pub struct PtyManager {
    inner: Arc<Inner>,
}

struct Inner {
    sessions: Mutex<HashMap<String, Arc<Session>>>,
    settings: SettingsStore,
    secrets: SecretBlob,
    events: EventLog,
    ssh_agent: SshAgentConfig,
    /// The server ssh-agent's socket while it runs. See [`PtyManager::set_server_ssh_agent`].
    server_ssh_agent: RwLock<Option<PathBuf>>,
    sidecar_env: RwLock<Option<SidecarSessionEnv>>,
    options: PtyOptions,
    next_client: AtomicU64,
}

/// The harness a live agent session runs, so its tab is titled after it.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionHarness {
    id: String,
    name: String,
}

/// The agent a workspace surfaces: the default harness's tab title and base
/// command, plus every harness a session can be started with.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    name: String,
    command: String,
    harnesses: Vec<HarnessSummary>,
    default_harness: String,
}

impl PtyManager {
    pub fn new(
        settings: SettingsStore,
        secrets: SecretBlob,
        events: EventLog,
        ssh_agent: SshAgentConfig,
        options: PtyOptions,
    ) -> Self {
        Self {
            inner: Arc::new(Inner {
                sessions: Mutex::new(HashMap::new()),
                settings,
                secrets,
                events,
                ssh_agent,
                server_ssh_agent: RwLock::new(None),
                sidecar_env: RwLock::new(None),
                options,
                next_client: AtomicU64::new(0),
            }),
        }
    }

    pub fn secrets(&self) -> &SecretBlob {
        &self.inner.secrets
    }

    pub fn options(&self) -> &PtyOptions {
        &self.inner.options
    }

    /// Sets the sidecar details later spawns get. Called by
    /// whatever starts the sidecar, each time it does.
    pub fn set_sidecar_env(&self, env: Option<SidecarSessionEnv>) {
        *self
            .inner
            .sidecar_env
            .write()
            .unwrap_or_else(|e| e.into_inner()) = env;
    }

    /// Sets the socket of the server's own ssh-agent, or `None` while it isn't
    /// running (the vault is locked). The server's ssh-agent calls this as it
    /// starts and stops. Later spawns use it when `ssh_agent.enabled` is on;
    /// running shells keep what they started with.
    pub fn set_server_ssh_agent(&self, socket: Option<PathBuf>) {
        *self
            .inner
            .server_ssh_agent
            .write()
            .unwrap_or_else(|e| e.into_inner()) = socket;
    }

    pub(crate) fn next_client_id(&self) -> u64 {
        self.inner.next_client.fetch_add(1, Ordering::SeqCst) + 1
    }

    fn get(&self, id: &str) -> Option<Arc<Session>> {
        lock(&self.inner.sessions).get(id).cloned()
    }

    fn max_sessions(&self) -> usize {
        resolve_max_sessions(self.inner.settings.snapshot().max_pty_sessions)
    }

    /// The configured (or default) base command a workspace's agent is
    /// launched from, read on each use so a change applies to the next session.
    fn agent_command(&self) -> String {
        resolve_agent_command(
            agent_command_env(),
            self.inner.settings.snapshot().agent_command,
        )
    }

    /// The built-in harness, the stored ones, and the stored default id, as
    /// they are stored on disk.
    fn harness_settings(&self) -> (ResolvedHarness, Vec<harness::AgentHarness>, Option<String>) {
        let settings = self.inner.settings.snapshot();
        (
            harness::builtin(
                resolve_agent_name(settings.agent_name.clone()),
                resolve_agent_command(agent_command_env(), settings.agent_command),
            ),
            settings.agent_harnesses.unwrap_or_default(),
            settings.default_agent_harness,
        )
    }

    /// The harness a launch runs (`requested` when given, otherwise the
    /// default) and the full environment it gets: its plain variables plus its
    /// secret ones. The secrets are read here, at launch, so the secret store
    /// is only touched for a harness that declares some.
    fn launch_harness(
        &self,
        requested: Option<&str>,
    ) -> Result<(ResolvedHarness, Vec<(String, String)>), String> {
        let (builtin, stored, default_id) = self.harness_settings();
        let harness = harness::resolve(builtin, &stored, default_id.as_deref(), requested)?;
        let mut env = harness.env.clone();
        if !harness.secret_env.is_empty() {
            let root = self.inner.secrets.read_root()?;
            env.extend(harness::secret_env_from_root(&root, &harness)?);
        }
        Ok((harness, env))
    }

    /// The program and full environment, secrets included, a headless Claude
    /// Code run uses for harness `id`. See [`harness::headless_run_env`].
    pub fn headless_harness(&self, id: &str) -> Result<(String, Vec<(String, String)>), String> {
        let (builtin, stored, default_id) = self.harness_settings();
        let harness = harness::resolve(builtin, &stored, default_id.as_deref(), Some(id))?;
        harness::headless_run_env(&harness, || self.inner.secrets.read_root())
    }

    /// Refuses a harness the sidecar names on the assistant's behalf that the
    /// user hasn't allowed it to start. See [`harness::check_assistant_may_launch`].
    pub fn check_sidecar_harness(
        &self,
        requested: Option<&str>,
        resuming: bool,
    ) -> Result<(), String> {
        let (builtin, stored, default_id) = self.harness_settings();
        harness::check_assistant_may_launch(
            builtin,
            &stored,
            default_id.as_deref(),
            requested,
            resuming,
        )
    }

    /// Returns the configured agent harnesses, so a client's own launches use
    /// the same commands the sidecar's are built from and label the tab the
    /// same way.
    pub fn agent_config(&self) -> AgentConfig {
        let (builtin, stored, default_id) = self.harness_settings();
        let harnesses = harness::all(builtin, &stored);
        let default_harness = harness::default_id(&stored, default_id.as_deref());
        let default = harnesses
            .iter()
            .find(|h| h.id == default_harness)
            .unwrap_or(&harnesses[0]);
        AgentConfig {
            name: default.name.clone(),
            command: default.command.clone(),
            default_harness,
            harnesses: harnesses.iter().map(Into::into).collect(),
        }
    }

    /// Spawns a shell in a new PTY. It opens in `spec.cwd` when given (e.g. a
    /// workspace folder), otherwise in `$HOME`.
    fn spawn_session(&self, id: &str, spec: &SpawnSpec) -> Result<Arc<Session>, String> {
        let pair = native_pty_system()
            .openpty(spec.size.pty())
            .map_err(|e| e.to_string())?;

        let shell = self
            .inner
            .options
            .shell
            .clone()
            .or_else(|| std::env::var("SHELL").ok())
            .unwrap_or_else(|| "/bin/zsh".to_string());
        let mut cmd = CommandBuilder::new(shell);
        cmd.env("TERM", "xterm-256color");
        let server_agent = self
            .inner
            .server_ssh_agent
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        match ssh_auth_sock(
            &self.inner.ssh_agent,
            server_agent.as_deref(),
            std::env::var_os("SSH_AUTH_SOCK"),
        ) {
            Some(socket) => cmd.env("SSH_AUTH_SOCK", socket),
            None => cmd.env_remove("SSH_AUTH_SOCK"),
        }
        if spec.strip_provider_secrets {
            cmd.env_remove("ANTHROPIC_API_KEY");
        }
        // After the strip, so a harness that sets its own provider key keeps it.
        if let Some(agent) = &spec.agent {
            for (key, value) in &agent.env {
                cmd.env(key, value);
            }
            // Read back by the SessionStart hook, so a relaunch after a restart
            // resumes with the harness the session started with. Signed below,
            // once the bearer is in reach.
            cmd.env(AGENT_HARNESS_ENV, &agent.identity.harness_id);
        }
        // Every session the UI can show carries the sidecar port and the two
        // scoped tokens, so whatever runs in it can post to the ingest endpoint
        // (keyed by this exact PTY id) and call the MCP endpoint, without ever
        // seeing the full-access bearer. The bearer only signs tokens.
        let sidecar = self
            .inner
            .sidecar_env
            .read()
            .unwrap_or_else(|e| e.into_inner())
            .clone();
        if let Some(sidecar) = sidecar {
            for (key, value) in session_env(
                id,
                sidecar.port,
                &sidecar.attention_token,
                &sidecar.signing_key,
                sidecar.mcp_token.as_deref(),
            ) {
                cmd.env(key, value);
            }
            // Without it, anything running in the terminal could register the
            // session under another saved harness and have it relaunched with
            // that one after a restart.
            if let Some(agent) = &spec.agent {
                cmd.env(
                    AGENT_HARNESS_TOKEN_ENV,
                    harness_token(&sidecar.signing_key, id, &agent.identity.harness_id),
                );
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
        let events = self.inner.events.clone();
        let manager = Arc::downgrade(&self.inner);
        let runtime = tokio::runtime::Handle::try_current().ok();
        let session_id = id.to_string();
        Session::start(
            pair,
            child,
            Start {
                size: spec.size,
                start_offset: spec.start_offset,
                initial_command: spec.initial_command.clone(),
                agent: spec.agent.as_ref().map(|a| a.identity.clone()),
                limits: Limits {
                    scrollback_cap: self.inner.options.scrollback_cap,
                    client_queue: self.inner.options.client_queue,
                },
                on_exit: Box::new(move |session, code| {
                    // A spawn that lost a race for its id never held it, so its
                    // exit says nothing about the session clients see there.
                    let held = manager.upgrade().is_some_and(|inner| {
                        lock(&inner.sessions)
                            .get(&session_id)
                            .is_none_or(|current| Arc::ptr_eq(current, session))
                    });
                    let Some(runtime) = runtime.filter(|_| held) else {
                        return;
                    };
                    runtime.spawn(async move {
                        let data = serde_json::json!({ "id": session_id, "code": code });
                        if let Err(e) = events.append(None, "pty.exited", data).await {
                            tracing::error!("couldn't record a PTY exit: {e}");
                        }
                    });
                }),
            },
        )
    }

    /// Spawns a session and inserts it under `id`, enforcing the session cap
    /// and handling a concurrent spawn of the same id. Returns the session that
    /// holds the id afterwards, which is the other spawn's when it won.
    fn spawn_into_state(&self, id: &str, spec: SpawnSpec) -> Result<Arc<Session>, String> {
        refuse_plain_review_shell(id, spec.initial_command.as_deref())?;
        // Checked before spawning, not after, so a flood of attaches doesn't
        // briefly hold more shells than the cap allows.
        {
            let cap = self.max_sessions();
            let sessions = lock(&self.inner.sessions);
            if sessions.len() >= cap && !sessions.contains_key(id) {
                return Err(too_many(cap));
            }
        }

        // Spawned outside the lock: openpty, spawn and the threads do real I/O
        // and would otherwise block every other PTY call meanwhile.
        let session = self.spawn_session(id, &spec)?;

        let mut sessions = lock(&self.inner.sessions);
        if let Some(winner) = sessions.get(id) {
            // A concurrent spawn for the same id won the race. Keep it and kill
            // ours, so no orphan shell is left behind.
            session.kill();
            return Ok(winner.clone());
        }
        // Checked again: spawns for different ids can all pass the check above
        // while each is still spawning.
        let cap = self.max_sessions();
        if sessions.len() >= cap {
            session.kill();
            return Err(too_many(cap));
        }
        sessions.insert(id.to_string(), session.clone());
        Ok(session)
    }

    /// Removes a dead session under `id` and returns the offset its stream
    /// ended at, or returns the live one. Either way the caller decides what
    /// to spawn.
    fn reap(&self, id: &str) -> Result<u64, Arc<Session>> {
        let mut sessions = lock(&self.inner.sessions);
        let Some(session) = sessions.get(id) else {
            return Ok(0);
        };
        if session.is_running() {
            return Err(session.clone());
        }
        let end = session.end_offset();
        sessions.remove(id);
        Ok(end)
    }

    /// The live session `id`, spawning a plain shell there when there is none
    /// or its shell has exited. The new shell carries on the dead one's offsets
    /// (see `SpawnSpec::start_offset`).
    pub fn attach_or_spawn(
        &self,
        id: &str,
        size: Size,
        cwd: Option<String>,
    ) -> Result<Arc<Session>, String> {
        let start_offset = match self.reap(id) {
            Ok(offset) => offset,
            Err(live) => return Ok(live),
        };
        self.spawn_into_state(
            id,
            SpawnSpec {
                size,
                cwd,
                initial_command: None,
                strip_provider_secrets: false,
                agent: None,
                start_offset,
            },
        )
    }

    /// True if a live session (its shell still running) exists for `id`.
    pub fn exists(&self, id: &str) -> bool {
        self.get(id).is_some_and(|s| s.is_running())
    }

    /// True when a non-shell foreground process is running in the PTY (the
    /// user is in vim, tailing logs, or running tests). False for unknown
    /// sessions and where the platform can't report a process group.
    pub fn is_busy(&self, id: &str) -> bool {
        self.get(id).is_some_and(|s| s.foreground_pid().is_some())
    }

    /// The harness the live session `id` was launched with, or `None` when no
    /// agent session is running there.
    pub fn session_harness(&self, id: &str) -> Option<SessionHarness> {
        let session = self.get(id)?;
        let agent = session.agent()?;
        Some(SessionHarness {
            id: agent.harness_id.clone(),
            name: agent.harness_name.clone(),
        })
    }

    pub async fn write(&self, id: &str, data: String) -> Result<(), String> {
        if data.len() > MAX_WRITE_BYTES {
            return Err(format!("pty_write payload exceeds {MAX_WRITE_BYTES} bytes"));
        }
        let session = self.get(id).ok_or("no such session")?;
        session.write(None, data.into_bytes()).await
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<(), String> {
        let session = self.get(id).ok_or("no such session")?;
        session.resize(Size { cols, rows })
    }

    /// Removes a session and kills its shell. No-op when the session is absent.
    pub fn kill(&self, id: &str) {
        let removed = lock(&self.inner.sessions).remove(id);
        if let Some(session) = removed {
            // Killing the child closes its PTY end; the reader then sees EOF
            // and reports the exit to clients and the event log.
            session.kill();
        }
    }

    /// Kills every session, for shutdown.
    pub fn kill_all(&self) {
        let sessions: Vec<_> = lock(&self.inner.sessions).drain().collect();
        for (_, session) in sessions {
            session.kill();
        }
    }

    /// Starts an agent session in `cwd` under the stable id
    /// `ws-claude:<workspace_id>`, which clients later attach to. Returns once
    /// the session is registered; it keeps running until killed or the server
    /// exits.
    ///
    /// The launch line is built here rather than taken from the caller, so a
    /// caller (the control channel included) chooses only *whether* to start
    /// an agent and which saved harness, by id, never what runs. The command
    /// itself comes from settings, which only an admin device can write; the
    /// one caller-supplied value that reaches the line is `name`, which
    /// `sanitize_session_name` strips before it is quoted. This is not argv
    /// safety, since the line is typed into an interactive shell, so both of
    /// those matter.
    ///
    /// `remote_control` adds Claude Code's `--remote-control`, which is only
    /// wanted when the launch came from somewhere the user isn't at the
    /// machine, such as a Telegram turn.
    ///
    /// `resume` is the id of a Claude Code session to continue, which the
    /// sidecar passes when it relaunches a workspace's agent after a restart.
    ///
    /// `harness` is the id of a saved harness; `None` means the default. An id
    /// that names no saved harness is refused rather than replaced by the
    /// default.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_claude_session(
        &self,
        workspace_id: &str,
        cwd: String,
        name: &str,
        remote_control: bool,
        resume: Option<&str>,
        instruction: Option<&str>,
        harness: Option<&str>,
    ) -> Result<(), String> {
        let (harness, env) = self.launch_harness(harness)?;
        check_resume(harness.kind, resume)?;
        check_remote_control(harness.kind, remote_control)?;
        let id = format!("ws-claude:{workspace_id}");
        let command = agent_launch_command(
            &harness.command,
            name,
            remote_control,
            resume,
            instruction,
            harness.prompt_args.as_deref(),
        );
        self.spawn_into_state(
            &id,
            SpawnSpec {
                size: Size {
                    cols: 120,
                    rows: 32,
                },
                cwd: Some(cwd),
                initial_command: Some(command),
                strip_provider_secrets: true,
                agent: Some(SpawnAgent {
                    identity: SessionAgent {
                        program: harness.program(),
                        harness_id: harness.id,
                        harness_name: harness.name,
                    },
                    env,
                }),
                // Nothing to carry: `spawn_into_state` keeps a session already
                // holding the id, so this spawn only lands where none does.
                start_offset: 0,
            },
        )
        .map(|_| ())
    }

    /// Starts Claude Code for a review workspace under
    /// `review-claude:<workspace_id>`, for the user to ask questions about its
    /// PRs. Like [`Self::spawn_claude_session`], the caller chooses only
    /// whether to start it: the program comes from the built-in agent's command
    /// (`agentCommand`), and the flags are fixed here. The sidecar supplies the
    /// folder to start in, the checkouts to add, the settings, a line of
    /// context for the prompt and whether the user chose to load the repos' own
    /// config, as it already does for the headless runs it spawns itself, so
    /// this grants it nothing new. Refused when the built-in agent isn't Claude
    /// Code, since the lockdown is made of Claude Code flags. Saved harnesses
    /// don't apply: a review session always runs the built-in agent.
    #[allow(clippy::too_many_arguments)]
    pub fn spawn_review_claude_session(
        &self,
        workspace_id: &str,
        cwd: String,
        add_dirs: &[String],
        settings: &str,
        context: &str,
        load_repo_config: bool,
    ) -> Result<(), String> {
        let program = exec_claude_program(&self.agent_command(), load_repo_config)
            .ok_or("the built-in agent is not Claude Code, so it can't run a review session")?;
        let context = check_review_spawn(workspace_id, &cwd, add_dirs, settings, context)?;
        let id = review_session_id(workspace_id);
        // A running session is left alone, before anything is written or
        // spawned. An exited one is replaced, and the new session's output
        // carries on from the old one's offsets.
        let start_offset = match self.reap(&id) {
            Ok(offset) => offset,
            Err(_live) => return Ok(()),
        };
        let real_cwd = std::fs::canonicalize(&cwd).map_err(|e| e.to_string())?;
        let dir = review_files_dir(&real_cwd, workspace_id)?;
        let settings_file = write_review_file(
            &dir,
            REVIEW_SETTINGS_FILE,
            &review_settings_with_dirs(settings, add_dirs)?,
        )?;
        let mut prompt = REVIEW_SESSION_GUARDRAIL.to_string();
        if load_repo_config {
            prompt = format!("{prompt} {REVIEW_SESSION_REPO_CONFIG_NOTE}");
        }
        if !context.trim().is_empty() {
            prompt = format!("{prompt} {}", context.trim());
        }
        let prompt_file = write_review_file(&dir, REVIEW_PROMPT_FILE, &prompt)?;
        let launch =
            review_launch_command(&program, &settings_file, &prompt_file, load_repo_config)?;
        self.spawn_into_state(
            &id,
            SpawnSpec {
                size: Size {
                    cols: 120,
                    rows: 32,
                },
                cwd: Some(cwd),
                initial_command: Some(launch),
                strip_provider_secrets: true,
                start_offset,
                agent: None,
            },
        )
        .map(|_| ())
    }

    /// Types `instruction` at the prompt of the agent session for
    /// `workspace_id` and submits it, exactly as if the user had typed it there.
    ///
    /// Refused unless the agent holds the PTY's foreground: a registered Claude
    /// process, or the program of the harness the session was launched with
    /// (see [`foreground_is_agent`]). The session is a real terminal: its agent
    /// can be interrupted, leaving the bare shell (where the text would run as
    /// a command line), or replaced by whatever the user ran next, and text
    /// plus a carriage return typed into `vim` or a REPL is no better. The
    /// check needs the foreground process group, so it is refused on platforms
    /// that can't report one.
    ///
    /// `agent_pids` are the agent processes the sidecar has on record for this
    /// session. They only widen what is recognised as the agent: a pid that
    /// has exited or doesn't lead the foreground matches nothing.
    ///
    /// What it still cannot establish is *what the agent is showing*. An agent
    /// sitting on a permission prompt or any select-list dialog also holds the
    /// foreground, and there the trailing carriage return answers the dialog
    /// rather than submitting a request. Callers must not describe this as
    /// unable to answer a prompt.
    ///
    /// The text and the Enter are separate writes, `INSTRUCTION_SUBMIT_DELAY`
    /// apart, and the checks run before each. An error that says the text was
    /// "typed but not submitted" means the text is sitting in the prompt
    /// unsent.
    pub fn send_session_instruction(
        &self,
        workspace_id: &str,
        instruction: &str,
        agent_pids: &[u32],
    ) -> Result<(), String> {
        let text = prepare_instruction(instruction)?;
        self.submit_at_agent_prompt(workspace_id, &text, agent_pids)
    }

    /// Types an allowed slash command, with any arguments, at the agent
    /// session's prompt for `workspace_id` and submits it. Held to the same
    /// foreground checks as [`Self::send_session_instruction`]. The difference
    /// is that the line may open with `/`, because the command comes from an
    /// allowlist only the user edits. The list is read on each send so a change
    /// applies right away.
    pub fn send_session_slash_command(
        &self,
        workspace_id: &str,
        command: &str,
        arguments: Option<&str>,
        agent_pids: &[u32],
    ) -> Result<(), String> {
        let allowed =
            merge_allowed_slash_commands(self.inner.settings.snapshot().allowed_slash_commands);
        let line = prepare_slash_command(command, arguments, &allowed)?;
        self.submit_at_agent_prompt(workspace_id, &line, agent_pids)
    }

    /// Types already-checked `text` at the agent's prompt, pauses, re-checks
    /// that the same agent still holds the prompt, then presses Enter. Client
    /// input waits from the text to the Enter, so nobody typing meanwhile can
    /// land keys inside the instruction or submit it early.
    fn submit_at_agent_prompt(
        &self,
        workspace_id: &str,
        text: &str,
        agent_pids: &[u32],
    ) -> Result<(), String> {
        let id = format!("ws-claude:{workspace_id}");
        let session = self.agent_session_for_input(&id, agent_pids)?;
        let gate = session.hold_input()?;
        // Checked again once what clients queued before the gate has reached
        // the PTY, since that input may have ended the agent.
        session.write_and_wait(&gate, b"")?;
        check_agent_reads_prompt(&session, agent_pids)?;
        session.write_and_wait(&gate, text.as_bytes())?;
        let typed_into = (session.shell_pid(), session.foreground_pid());
        std::thread::sleep(self.inner.options.submit_delay);
        let not_submitted = |e: String| format!("the text was typed but not submitted: {e}");
        // Checked again before the Enter: if the agent exited or was replaced
        // during the pause, the Enter would run the typed text in whatever
        // reads it now. Comparing pids also catches a different agent process
        // that would still pass `foreground_is_agent`, and the map lookup
        // catches the session itself being replaced.
        let current = self
            .agent_session_for_input(&id, agent_pids)
            .map_err(not_submitted)?;
        if !Arc::ptr_eq(&current, &session)
            || (session.shell_pid(), session.foreground_pid()) != typed_into
        {
            return Err(not_submitted(
                "the agent was replaced during the pause".into(),
            ));
        }
        session.write_and_wait(&gate, b"\r").map_err(not_submitted)
    }

    /// The running session `id`, when the agent it was launched with is what
    /// reads its prompt; otherwise why text must not be typed there.
    fn agent_session_for_input(
        &self,
        id: &str,
        agent_pids: &[u32],
    ) -> Result<Arc<Session>, String> {
        let session = self
            .get(id)
            .ok_or("no agent session is running for that workspace")?;
        check_agent_reads_prompt(&session, agent_pids)?;
        Ok(session)
    }
}

fn check_agent_reads_prompt(session: &Session, agent_pids: &[u32]) -> Result<(), String> {
    if !session.is_running() {
        return Err("the agent session has exited".into());
    }
    if !foreground_is_agent(session, agent_pids) {
        return Err(
            "the configured agent is not what is reading that session's prompt; open the workspace and check what is running there".into(),
        );
    }
    Ok(())
}

fn too_many(cap: usize) -> String {
    format!("too many PTY sessions (cap: {cap}); close one before opening another")
}

/// True when the process reading the PTY's input is the agent the session was
/// launched with. Two ways to know that:
///
/// - `agent_pids`, the Claude Code processes that registered themselves for
///   this session through the workspace's SessionStart hook. A match means
///   that agent leads the PTY's foreground process group, whatever its
///   executable is called on disk. Only the leader counts: a registered
///   `claude -p` run as a child of a script in the foreground is in the
///   script's group, and the script is what reads the terminal.
/// - Otherwise, the foreground executable's file name against the program of
///   the harness the session was launched with (past any leading `VAR=value`).
///   This covers an agent that registers nothing: Pi, OpenCode, a built-in
///   command that isn't Claude Code, or a session started before the hook was
///   installed. Claude Code's native installer fails it: `claude` links to
///   `versions/<version>`, and that version-numbered file is what the OS
///   reports. A saved custom harness has no program to match (see
///   [`ResolvedHarness::program`]), so it passes only through a registered pid.
///
/// Matching on the process rather than on "anything that isn't the shell" is
/// what makes this a gate: `vim`, a language REPL, or a test run left in the
/// foreground would all pass the weaker check and then be handed a line of
/// text and a carriage return.
///
/// It fails closed, and an unregistered agent installed as a script rather
/// than a binary fails with it: the foreground executable is then the
/// interpreter (`node`, `bun`), which doesn't match the harness's program, so
/// the send is refused rather than delivered to a process this can't identify.
fn foreground_is_agent(session: &Session, agent_pids: &[u32]) -> bool {
    let Some(pid) = session.foreground_pid() else {
        tracing::warn!(
            "refused instruction: no process other than the shell holds the session's foreground"
        );
        return false;
    };
    if agent_pids.contains(&pid) {
        return true;
    }
    let Some(exe) = process::process_executable(pid) else {
        tracing::warn!("refused instruction: could not read the executable of pid {pid}");
        return false;
    };
    let Some(argv0) = session.agent().and_then(|agent| agent.program.as_deref()) else {
        tracing::warn!(
            "refused instruction: the session has no program to compare the foreground against (a plain terminal, or a custom harness)"
        );
        return false;
    };
    let expected = Path::new(argv0).file_name().unwrap_or(argv0.as_ref());
    let matched = Path::new(&exe).file_name() == Some(expected);
    if !matched {
        // The command itself isn't logged: it is user-written and can carry
        // an inline `VAR=secret` assignment.
        tracing::warn!(
            "refused instruction: foreground executable {exe} is not the session's agent, and none of the {} registered agent pid(s) leads the foreground process group",
            agent_pids.len()
        );
    }
    matched
}
