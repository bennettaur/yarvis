//! The server's own ssh-agent, for signing git commits with the vault's
//! Ed25519 key. Off unless `ssh_agent.enabled` is set: a work laptop keeps
//! its signing key in 1Password, and then nothing here runs, makes a key or
//! opens a socket.
//!
//! When on, the agent listens on `ssh-agent.sock` in the data dir (or wherever
//! `socket_dir` puts it) while the vault is unlocked, and stops (removing the
//! socket) when it locks. It signs
//! only SSHSIG blobs in the `git` namespace, so the key can't log in to a
//! host, and every signature waits for an answer on the approvals route
//! unless a grant (below) covers it.
//!
//! An approver can also allow signing for a while ([`MAX_GRANT`] at most), as
//! 1Password's agent does. Until then every signature is made without asking,
//! for any process that can reach the socket, and each one is recorded on the
//! event log. The grant lives only in memory: locking the vault, stopping the
//! agent or restarting the server ends it, and so does `DELETE
//! /api/vault/ssh-agent/grant`.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get};
use axum::{Json, Router};
use serde::Serialize;
use serde_json::json;
use signature::Signer;
use ssh_agent_lib::agent::{Session, listen};
use ssh_agent_lib::error::AgentError;
use ssh_agent_lib::proto::{Identity, PublicCredential, SignRequest};
use ssh_key::private::Ed25519Keypair;
use ssh_key::public::{Ed25519PublicKey, KeyData};
use ssh_key::{HashAlg, PublicKey, Signature};
use tokio::net::UnixListener;
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::AppState;
use crate::approvals::{Approvals, Decision};
use crate::auth::{Approve, Authed, Read};
use crate::config::Config;
use crate::error::{ApiError, ApiResult};
use crate::events::EventLog;
use crate::socket_dir;
use crate::store::now_ms;

/// The approval kind a signature request is filed under.
pub const APPROVAL_KIND: &str = "git.sign";

/// How long a signature waits for an answer. `git commit` blocks meanwhile.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

/// The longest an approver can allow signing without asking. Long enough for
/// a rebase or a working session, short enough that a forgotten grant ends
/// the same hour.
pub const MAX_GRANT: Duration = Duration::from_secs(60 * 60);

const SOCKET_NAME: &str = "ssh-agent.sock";
const KEY_COMMENT: &str = "yarvis-server";

/// Where workspace shells point `SSH_AUTH_SOCK`, or `None` when the agent is
/// off. It is the path even while the vault is locked, so a shell started then
/// fails to sign until unlock instead of quietly reaching some other agent.
pub fn socket_path(state: &AppState) -> Option<PathBuf> {
    configured_socket(&state.config)
}

/// [`socket_path`], for code that runs before the `AppState` exists.
pub(crate) fn configured_socket(config: &Config) -> Option<PathBuf> {
    config
        .ssh_agent
        .enabled
        .then(|| socket_dir::socket_path(&config.server, SOCKET_NAME))
}

/// The OpenSSH public key for a seed, as `ssh-ed25519 AAAA… yarvis-server`.
pub fn public_key_openssh(seed: &[u8; 32]) -> String {
    let key = Ed25519Keypair::from_seed(seed);
    PublicKey::new(KeyData::Ed25519(key.public), KEY_COMMENT)
        .to_openssh()
        .expect("an Ed25519 key encodes")
}

/// The running agent, if any. Shared through `AppState`.
#[derive(Clone, Default)]
pub struct SshAgent(Arc<Mutex<Option<RunningAgent>>>);

impl SshAgent {
    pub fn is_running(&self) -> bool {
        lock(&self.0).is_some()
    }

    /// The public key being served, while running.
    pub fn public_key(&self) -> Option<String> {
        lock(&self.0).as_ref().map(|r| r.public_key.clone())
    }

    /// While a grant is active: when it ends, in milliseconds since the
    /// epoch, and how long it has left.
    pub fn grant_ends(&self) -> Option<(i64, Duration)> {
        lock(&self.0)
            .as_ref()
            .and_then(|r| r.shared.active_grant())
            .map(|g| (g.expires_at_ms, g.remaining()))
    }

    /// Ends the grant early. Returns whether one was active.
    pub fn end_grant(&self) -> bool {
        lock(&self.0)
            .as_ref()
            .is_some_and(|r| r.shared.drop_grant())
    }
}

/// Nothing panics while holding these locks, so a poisoned one is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// Starts the agent if it is enabled and not already running. Called after
/// every unlock. Makes the signing key on the first run.
pub fn start(state: &AppState) -> Result<(), String> {
    let Some(socket) = socket_path(state) else {
        return Ok(());
    };
    let mut running = lock(&state.ssh_agent.0);
    if running.is_some() {
        return Ok(());
    }
    let seed = state
        .vault
        .signing_seed()
        .map_err(|e| format!("couldn't read the signing key: {e}"))?;
    let agent = VaultAgent::new(
        &seed,
        state.approvals.clone(),
        state.events.clone(),
        APPROVAL_TIMEOUT,
    );
    socket_dir::prepare(&state.config.server, &socket)?;
    *running = Some(spawn(agent, socket).map_err(|e| format!("couldn't open the socket: {e}"))?);
    tracing::info!("ssh-agent listening");
    Ok(())
}

/// Locks the vault, then stops the agent and removes its socket. Signatures
/// waiting for approval are refused. Returns whether the vault was unlocked.
///
/// The agent's lock is held across both steps, and [`start`] takes it before
/// reading the key, so an unlock racing this can't start an agent after the
/// stop and leave it running on a locked vault.
pub fn stop_and_lock(state: &AppState) -> bool {
    let mut running = lock(&state.ssh_agent.0);
    let was_unlocked = state.vault.lock();
    if running.take().is_some() {
        tracing::info!("ssh-agent stopped");
    }
    was_unlocked
}

/// One Ed25519 key and the approval every signature needs.
///
/// Each connection gets a clone, and connections outlive the listener, so the
/// key and the stop signal are shared: stopping drops the key for every
/// clone and refuses any signature still waiting for an answer.
#[derive(Clone)]
pub struct VaultAgent {
    shared: Arc<Shared>,
    public: Ed25519PublicKey,
    approvals: Approvals,
    events: EventLog,
    timeout: Duration,
}

struct Shared {
    key: Mutex<Option<Ed25519Keypair>>,
    grant: Mutex<Option<Grant>>,
    stopped: watch::Sender<bool>,
}

/// Signing allowed without asking until whichever of its two clocks runs out
/// first. On macOS `Instant` stops while the machine sleeps, so the wall
/// clock ends a grant slept through; setting the wall clock back can't stretch
/// it, because `deadline` still runs.
#[derive(Clone)]
struct Grant {
    /// Tells one grant from the next, so a signature started under one isn't
    /// recorded under another that replaced it.
    id: u64,
    /// Milliseconds since the epoch.
    expires_at_ms: i64,
    deadline: Instant,
    /// The device that allowed it.
    by: String,
}

impl Grant {
    fn new(allow_for: Duration, by: &str) -> Self {
        static NEXT_ID: AtomicU64 = AtomicU64::new(1);
        Self {
            id: NEXT_ID.fetch_add(1, Ordering::Relaxed),
            expires_at_ms: now_ms().saturating_add(allow_for.as_millis() as i64),
            deadline: Instant::now() + allow_for,
            by: by.to_string(),
        }
    }

    fn has_run_out(&self) -> bool {
        self.expires_at_ms <= now_ms() || self.deadline <= Instant::now()
    }

    /// How long it has left, by the clock that ends it first.
    fn remaining(&self) -> Duration {
        let by_wall =
            Duration::from_millis(self.expires_at_ms.saturating_sub(now_ms()).max(0) as u64);
        by_wall.min(self.deadline.saturating_duration_since(Instant::now()))
    }
}

impl Shared {
    /// Drops the key, which zeroizes it, ends any grant, and wakes every
    /// waiting signature. `stopped` is set before the grant is taken, so a
    /// [`start_grant`](VaultAgent::start_grant) that checks it under the grant
    /// lock either sees it or has its grant taken here.
    fn stop(&self) {
        lock(&self.key).take();
        self.stopped.send_replace(true);
        lock(&self.grant).take();
    }

    /// The grant, if one is active. Drops one that has run out.
    fn active_grant(&self) -> Option<Grant> {
        let mut grant = lock(&self.grant);
        if grant.as_ref().is_some_and(Grant::has_run_out) {
            grant.take();
        }
        grant.clone()
    }

    /// Whether `grant` is still the active one: not run out, stopped, or
    /// replaced by another grant.
    fn is_current(&self, grant: &Grant) -> bool {
        self.active_grant().is_some_and(|g| g.id == grant.id)
    }

    /// Returns whether a grant was there to drop.
    fn drop_grant(&self) -> bool {
        lock(&self.grant).take().is_some()
    }
}

impl VaultAgent {
    pub fn new(seed: &[u8; 32], approvals: Approvals, events: EventLog, timeout: Duration) -> Self {
        let key = Ed25519Keypair::from_seed(seed);
        Self {
            public: key.public,
            shared: Arc::new(Shared {
                key: Mutex::new(Some(key)),
                grant: Mutex::new(None),
                stopped: watch::channel(false).0,
            }),
            approvals,
            events,
            timeout,
        }
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey::new(KeyData::Ed25519(self.public), KEY_COMMENT)
    }

    fn fingerprint(&self) -> String {
        self.public_key().fingerprint(HashAlg::Sha256).to_string()
    }

    /// Asks the approvals route. A denial, a timeout, a failure to ask, or the
    /// agent stopping meanwhile comes back as a decision that isn't `Approved`.
    async fn ask_approval(&self, hash_alg: &str) -> Decision {
        let fingerprint = self.fingerprint();
        // SSHSIG carries only a hash of the commit, so the key is all there
        // is to show.
        let summary = format!("Sign a git commit or tag with {fingerprint}");
        let detail = json!({
            "namespace": "git",
            "keyFingerprint": fingerprint,
            "hashAlgorithm": hash_alg,
        });
        let mut stopped = self.shared.stopped.subscribe();
        let request = self.approvals.request_allowing_grant(
            APPROVAL_KIND,
            &summary,
            detail,
            self.timeout,
            MAX_GRANT,
        );
        // Dropping the request when the agent stops settles the approval as
        // abandoned, so a late "yes" can't land.
        tokio::select! {
            decision = request => {
                decision.unwrap_or_else(|e| {
                    tracing::error!("couldn't ask for a signature approval: {e}");
                    Decision::Unanswered
                })
            }
            _ = stopped.wait_for(|stopped| *stopped) => Decision::Unanswered,
        }
    }

    /// Starts a grant, unless the agent stopped while the approval was out.
    /// The signature that was approved goes ahead either way: the approver
    /// said yes to it, whatever happens to the grant.
    ///
    /// Installed before it is recorded, so nothing that lands during the
    /// record (a Stop, a lock) can be undone by it, and the event's refetch
    /// finds it. A signature made meanwhile is recorded on its own.
    async fn start_grant(&self, allow_for: Duration, by: &str) {
        let new = Grant::new(allow_for, by);
        let (id, expires_at_ms) = (new.id, new.expires_at_ms);
        {
            let mut grant = lock(&self.shared.grant);
            // Checked under the grant lock, which `stop` takes after setting
            // `stopped`, so a grant can't land on a stopped agent.
            if *self.shared.stopped.borrow() {
                return;
            }
            // Two approvals answered together keep the longer grant.
            if grant
                .as_ref()
                .is_some_and(|g| !g.has_run_out() && g.expires_at_ms >= expires_at_ms)
            {
                return;
            }
            *grant = Some(new);
        }
        let recorded = self
            .events
            .append(
                Some(by),
                "ssh_agent.grant_started",
                json!({ "expiresAt": expires_at_ms, "keyFingerprint": self.fingerprint() }),
            )
            .await;
        if let Err(e) = recorded {
            // A grant nobody can see on the log isn't one to keep. Only this
            // one: another may have replaced it meanwhile.
            let mut grant = lock(&self.shared.grant);
            if grant.as_ref().is_some_and(|g| g.id == id) {
                grant.take();
            }
            tracing::error!("couldn't record a signing grant, so it was dropped: {e}");
        }
    }

    /// Records a signature made under a grant. Without the record there is no
    /// trace of it, so a failure refuses the signature.
    async fn record_signature_under_grant(
        &self,
        grant: &Grant,
        hash_alg: &str,
    ) -> Result<(), AgentError> {
        self.events
            .append(
                None,
                "ssh_agent.signed",
                json!({
                    "keyFingerprint": self.fingerprint(),
                    "hashAlgorithm": hash_alg,
                    "grantedBy": grant.by,
                    "grantExpiresAt": grant.expires_at_ms,
                }),
            )
            .await
            .map(|_| ())
            .map_err(|e| refuse(&format!("couldn't record the signature: {e}")))
    }
}

/// The `index`th length-prefixed string after the `SSHSIG` magic:
/// namespace, reserved, hash algorithm, then the message hash.
fn sshsig_field(data: &[u8], index: usize) -> Option<&[u8]> {
    let mut rest = data.strip_prefix(b"SSHSIG")?;
    for _ in 0..index {
        let (_, after) = split_string(rest)?;
        rest = after;
    }
    split_string(rest).map(|(field, _)| field)
}

fn split_string(data: &[u8]) -> Option<(&[u8], &[u8])> {
    let (len, rest) = data.split_at_checked(4)?;
    let len = u32::from_be_bytes(len.try_into().ok()?) as usize;
    Some((rest.get(..len)?, &rest[len..]))
}

/// The SSHSIG namespace of `data`, or `None` when it isn't an SSHSIG blob
/// (an SSH login handshake, for one).
pub fn sshsig_namespace(data: &[u8]) -> Option<String> {
    String::from_utf8(sshsig_field(data, 0)?.to_vec()).ok()
}

fn refuse(message: &str) -> AgentError {
    AgentError::other(std::io::Error::other(message.to_owned()))
}

#[ssh_agent_lib::async_trait]
impl Session for VaultAgent {
    async fn request_identities(&mut self) -> Result<Vec<Identity>, AgentError> {
        if lock(&self.shared.key).is_none() {
            return Ok(Vec::new());
        }
        Ok(vec![Identity {
            credential: PublicCredential::Key(KeyData::Ed25519(self.public)),
            comment: KEY_COMMENT.into(),
        }])
    }

    async fn sign(&mut self, request: SignRequest) -> Result<Signature, AgentError> {
        let PublicCredential::Key(KeyData::Ed25519(public)) = &request.credential else {
            return Err(refuse("unknown key"));
        };
        if *public != self.public {
            return Err(refuse("unknown key"));
        }
        // Checked before anyone is asked, so a login attempt never reaches an
        // approver who might tap yes out of habit.
        if sshsig_namespace(&request.data).as_deref() != Some("git") {
            return Err(refuse("this agent only signs git objects"));
        }
        // The two algorithms SSHSIG defines. The name is shown to approvers,
        // so nothing else gets that far.
        let hash_alg = match sshsig_field(&request.data, 2) {
            Some(b"sha256") => "sha256",
            Some(b"sha512") => "sha512",
            _ => return Err(refuse("unknown SSHSIG hash algorithm")),
        };
        let grant = self.shared.active_grant();
        if grant.is_none() {
            let Decision::Approved { by, allow_for } = self.ask_approval(hash_alg).await else {
                return Err(refuse("signature denied"));
            };
            if let Some(allow_for) = allow_for {
                // The approvals already held it to MAX_GRANT; this keeps the
                // agent's own limit should that ever change.
                self.start_grant(allow_for.min(MAX_GRANT), &by).await;
            }
        }
        let signature = {
            let key = lock(&self.shared.key);
            let key = key.as_ref().ok_or_else(|| refuse("the vault is locked"))?;
            key.try_sign(&request.data).map_err(AgentError::other)?
        };
        if let Some(grant) = grant {
            // Signed before recording, so a locked vault leaves no "signed"
            // event. Checked again afterwards, so a Stop pressed during the
            // signing wins, and so is the grant's identity: one that replaced
            // it isn't what the signature started under.
            if !self.shared.is_current(&grant) {
                return Err(refuse("signing without asking was stopped"));
            }
            self.record_signature_under_grant(&grant, hash_alg).await?;
        }
        Ok(signature)
    }
}

/// A listening agent. Dropping it stops the listener, drops the key from
/// every open connection, and removes the socket.
pub struct RunningAgent {
    socket: PathBuf,
    public_key: String,
    shared: Arc<Shared>,
    task: JoinHandle<()>,
}

impl Drop for RunningAgent {
    fn drop(&mut self) {
        self.shared.stop();
        self.task.abort();
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// Listens on `socket`, readable and writable only by this user. A socket
/// left by a crashed run is replaced.
pub fn spawn(agent: VaultAgent, socket: PathBuf) -> std::io::Result<RunningAgent> {
    use std::os::unix::fs::PermissionsExt;
    match std::fs::remove_file(&socket) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e),
        _ => {}
    }
    let listener = UnixListener::bind(&socket)?;
    std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600))?;
    let public_key = agent
        .public_key()
        .to_openssh()
        .map_err(std::io::Error::other)?;
    let shared = agent.shared.clone();
    let task = tokio::spawn(async move {
        if let Err(e) = listen(listener, agent).await {
            tracing::error!("ssh-agent listener stopped: {e}");
        }
    });
    Ok(RunningAgent {
        socket,
        public_key,
        shared,
        task,
    })
}

// ---- routes ----

/// `GET /api/vault/ssh-agent` and `DELETE /api/vault/ssh-agent/grant`, which
/// answer 404 when the agent is off.
pub fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/vault/ssh-agent", get(status))
        .route("/api/vault/ssh-agent/grant", delete(end_grant))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            only_when_enabled,
        ))
}

async fn only_when_enabled(
    State(state): State<AppState>,
    request: Request,
    next: Next,
) -> Response {
    if !state.config.ssh_agent.enabled {
        return ApiError::not_found().into_response();
    }
    next.run(request).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    enabled: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    public_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    socket_path: Option<String>,
    /// While signing is allowed without asking, when that ends, in
    /// milliseconds since the epoch.
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_expires_at: Option<i64>,
    /// The same, as time left. A client's clock can differ from the
    /// server's, so this is what it should count down from.
    #[serde(skip_serializing_if = "Option::is_none")]
    grant_remaining_ms: Option<u64>,
}

async fn status(State(state): State<AppState>, _: Authed<Read>) -> ApiResult<Json<Status>> {
    let running = state.ssh_agent.is_running();
    let grant = state.ssh_agent.grant_ends();
    Ok(Json(Status {
        enabled: true,
        public_key: state.ssh_agent.public_key(),
        socket_path: socket_path(&state)
            .filter(|_| running)
            .map(|p| p.display().to_string()),
        grant_expires_at: grant.map(|(at, _)| at),
        grant_remaining_ms: grant.map(|(_, left)| left.as_millis() as u64),
    }))
}

/// Goes back to asking for every signature. Answers 204 whether or not a
/// grant was active, so a second press doesn't read as a failure.
async fn end_grant(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Approve>,
) -> ApiResult<StatusCode> {
    if state.ssh_agent.end_grant() {
        // The grant has ended whether or not this lands, so a failure to
        // record it isn't the caller's error.
        let recorded = state
            .events
            .append(
                Some(&device.device_id),
                "ssh_agent.grant_ended",
                json!({ "reason": "stopped" }),
            )
            .await;
        if let Err(e) = recorded {
            tracing::error!("couldn't record the end of a signing grant: {e}");
        }
    }
    Ok(StatusCode::NO_CONTENT)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::Approvals;
    use crate::events::EventLog;

    fn sshsig_blob(namespace: &str) -> Vec<u8> {
        let mut blob = b"SSHSIG".to_vec();
        for field in [namespace.as_bytes(), b"", b"sha512", &[0u8; 64]] {
            blob.extend_from_slice(&(field.len() as u32).to_be_bytes());
            blob.extend_from_slice(field);
        }
        blob
    }

    async fn approvals() -> Approvals {
        let store = crate::store::testing::store().await;
        Approvals::new(store.clone(), EventLog::new(store))
    }

    fn agent(approvals: &Approvals, timeout: Duration) -> VaultAgent {
        VaultAgent::new(
            &[3u8; 32],
            approvals.clone(),
            approvals.events().clone(),
            timeout,
        )
    }

    fn request(agent: &VaultAgent, data: Vec<u8>) -> SignRequest {
        SignRequest {
            credential: PublicCredential::Key(KeyData::Ed25519(agent.public)),
            data,
            flags: 0,
        }
    }

    /// Answers the first pending approval once it appears.
    /// The first pending approval, failing after 5 seconds without one.
    async fn next_pending(approvals: &Approvals) -> crate::approvals::Pending {
        let deadline = tokio::time::Instant::now() + Duration::from_secs(5);
        loop {
            if let Some(pending) = approvals.pending().await.unwrap().into_iter().next() {
                return pending;
            }
            assert!(
                tokio::time::Instant::now() < deadline,
                "no approval was requested"
            );
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    async fn answer_next(approvals: &Approvals, approve: bool) -> crate::approvals::Pending {
        answer_next_allowing(approvals, approve, None).await
    }

    async fn answer_next_allowing(
        approvals: &Approvals,
        approve: bool,
        allow_for: Option<Duration>,
    ) -> crate::approvals::Pending {
        let pending = next_pending(approvals).await;
        approvals
            .answer(&pending.id, "device", approve, allow_for)
            .await
            .unwrap();
        pending
    }

    /// The events of one kind, oldest first.
    async fn events_of(approvals: &Approvals, kind: &str) -> Vec<serde_json::Value> {
        approvals
            .events()
            .since(0)
            .await
            .unwrap()
            .into_iter()
            .filter(|e| e.kind == kind)
            .map(|e| e.data)
            .collect()
    }

    #[test]
    fn parses_sshsig_fields() {
        let blob = sshsig_blob("git");
        assert_eq!(sshsig_namespace(&blob).as_deref(), Some("git"));
        assert_eq!(sshsig_field(&blob, 2), Some(&b"sha512"[..]));
        assert_eq!(sshsig_namespace(b"not a blob"), None);
        assert_eq!(sshsig_namespace(b"SSHSIG\x00\x00\x00\xffgit"), None);
    }

    #[tokio::test]
    async fn an_approved_request_signs() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move { answer_next(&approvals, true).await }
        });
        let req = request(&agent, sshsig_blob("git"));
        agent.sign(req).await.unwrap();
        let pending = answer.await.unwrap();
        assert_eq!(pending.kind, APPROVAL_KIND);
        let fingerprint = agent.public_key().fingerprint(HashAlg::Sha256).to_string();
        assert!(
            pending.summary.contains(&fingerprint),
            "{}",
            pending.summary
        );
        assert_eq!(pending.data["hashAlgorithm"], "sha512");
    }

    #[tokio::test]
    async fn a_denied_request_is_refused() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move { answer_next(&approvals, false).await }
        });
        let req = request(&agent, sshsig_blob("git"));
        assert!(agent.sign(req).await.is_err());
        answer.await.unwrap();
    }

    #[tokio::test]
    async fn an_unanswered_request_times_out_as_denied() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_millis(50));
        let req = request(&agent, sshsig_blob("git"));
        assert!(agent.sign(req).await.is_err());
        assert!(approvals.pending().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn non_git_data_is_refused_before_anyone_is_asked() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let login = request(&agent, b"session-id-and-userauth".to_vec());
        assert!(agent.sign(login).await.is_err());
        let file = request(&agent, sshsig_blob("file"));
        assert!(agent.sign(file).await.is_err());
        let mut odd_hash = b"SSHSIG".to_vec();
        for field in [&b"git"[..], b"", b"md5", &[0u8; 16]] {
            odd_hash.extend_from_slice(&(field.len() as u32).to_be_bytes());
            odd_hash.extend_from_slice(field);
        }
        assert!(agent.sign(request(&agent, odd_hash)).await.is_err());
        assert!(approvals.pending().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn another_key_is_refused() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let other = Ed25519Keypair::from_seed(&[4u8; 32]);
        let req = SignRequest {
            credential: PublicCredential::Key(KeyData::Ed25519(other.public)),
            data: sshsig_blob("git"),
            flags: 0,
        };
        assert!(agent.sign(req).await.is_err());
    }

    #[tokio::test]
    async fn stopping_refuses_a_waiting_signature_and_drops_the_key() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(30));
        let shared = agent.shared.clone();
        let sign = tokio::spawn({
            let mut agent = agent.clone();
            async move { agent.sign(request(&agent, sshsig_blob("git"))).await }
        });
        next_pending(&approvals).await;
        shared.stop();
        assert!(sign.await.unwrap().is_err());
        assert!(agent.request_identities().await.unwrap().is_empty());
        let after = request(&agent, sshsig_blob("git"));
        assert!(agent.sign(after).await.is_err());
    }

    #[tokio::test]
    async fn a_grant_signs_later_requests_without_asking_and_records_each() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move { answer_next_allowing(&approvals, true, Some(Duration::from_secs(300))).await }
        });
        agent
            .sign(request(&agent, sshsig_blob("git")))
            .await
            .unwrap();
        let pending = answer.await.unwrap();
        assert_eq!(pending.max_allow_for_secs, Some(MAX_GRANT.as_secs() as u32));
        assert!(agent.shared.active_grant().is_some());

        for _ in 0..3 {
            agent
                .sign(request(&agent, sshsig_blob("git")))
                .await
                .unwrap();
        }
        assert!(approvals.pending().await.unwrap().is_empty());
        let fingerprint = agent.fingerprint();
        let started = events_of(&approvals, "ssh_agent.grant_started").await;
        assert_eq!(started.len(), 1);
        assert_eq!(started[0]["keyFingerprint"], fingerprint.as_str());
        let expires_at = started[0]["expiresAt"].as_i64().unwrap();
        assert!(expires_at > now_ms() + 290_000, "{expires_at}");
        let signed = events_of(&approvals, "ssh_agent.signed").await;
        assert_eq!(signed.len(), 3, "each unasked signature is recorded");
        assert_eq!(signed[0]["grantedBy"], "device");
        assert_eq!(signed[0]["keyFingerprint"], fingerprint.as_str());
        assert_eq!(signed[0]["hashAlgorithm"], "sha512");
        assert_eq!(signed[0]["grantExpiresAt"], expires_at);
    }

    /// A grant whose wall-clock end is `expires_in_ms` away, positive or not.
    /// Its monotonic deadline is five minutes out.
    fn grant(expires_in_ms: i64) -> Grant {
        Grant {
            expires_at_ms: now_ms() + expires_in_ms,
            ..Grant::new(Duration::from_secs(300), "device")
        }
    }

    #[test]
    fn a_grant_ends_by_whichever_clock_runs_out_first() {
        // The wall clock passed its end, as after a night asleep.
        assert!(grant(-1_000).has_run_out());
        // The wall clock was set back, but the monotonic deadline passed.
        let rolled_back = Grant {
            expires_at_ms: now_ms() + 3_600_000,
            deadline: Instant::now(),
            ..Grant::new(Duration::from_secs(300), "device")
        };
        assert!(rolled_back.has_run_out());
        assert_eq!(rolled_back.remaining(), Duration::ZERO);
        let fresh = Grant::new(Duration::from_secs(300), "device");
        assert!(!fresh.has_run_out());
        assert!(fresh.remaining() <= Duration::from_secs(300));
        assert_ne!(fresh.id, Grant::new(Duration::from_secs(300), "device").id);
    }

    #[tokio::test]
    async fn a_shorter_grant_doesnt_cut_a_longer_one_short() {
        let approvals = approvals().await;
        let agent = agent(&approvals, Duration::from_secs(5));
        agent.start_grant(Duration::from_secs(900), "phone").await;
        agent.start_grant(Duration::from_secs(300), "laptop").await;
        assert_eq!(agent.shared.active_grant().unwrap().by, "phone");
        agent
            .start_grant(Duration::from_secs(1_800), "laptop")
            .await;
        assert_eq!(agent.shared.active_grant().unwrap().by, "laptop");
    }

    #[tokio::test]
    async fn a_grant_never_lets_through_what_asking_would_refuse() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        *lock(&agent.shared.grant) = Some(grant(300_000));
        let login = request(&agent, b"session-id-and-userauth".to_vec());
        assert!(agent.sign(login).await.is_err());
        assert!(
            agent
                .sign(request(&agent, sshsig_blob("file")))
                .await
                .is_err()
        );
        assert!(events_of(&approvals, "ssh_agent.signed").await.is_empty());
    }

    #[tokio::test]
    async fn an_expired_grant_asks_again() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_millis(50));
        *lock(&agent.shared.grant) = Some(grant(-1_000));
        // Nobody answers, so asking is what refuses it.
        assert!(
            agent
                .sign(request(&agent, sshsig_blob("git")))
                .await
                .is_err()
        );
        assert!(agent.shared.active_grant().is_none());
        assert!(events_of(&approvals, "ssh_agent.signed").await.is_empty());
    }

    #[tokio::test]
    async fn stopping_or_ending_the_grant_goes_back_to_asking() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_millis(50));
        *lock(&agent.shared.grant) = Some(grant(300_000));
        assert!(agent.shared.drop_grant());
        assert!(!agent.shared.drop_grant(), "nothing left to drop");
        assert!(agent.shared.active_grant().is_none());

        *lock(&agent.shared.grant) = Some(grant(300_000));
        agent.shared.stop();
        assert!(agent.shared.active_grant().is_none());
        // Refused with nobody asked and nothing recorded as signed.
        assert!(
            agent
                .sign(request(&agent, sshsig_blob("git")))
                .await
                .is_err()
        );
        assert!(approvals.pending().await.unwrap().is_empty());
        assert!(events_of(&approvals, "ssh_agent.signed").await.is_empty());
    }

    #[tokio::test]
    async fn a_grant_approved_as_the_agent_stops_is_not_kept() {
        let approvals = approvals().await;
        let agent = agent(&approvals, Duration::from_secs(5));
        agent.shared.stop();
        agent.start_grant(Duration::from_secs(300), "device").await;
        assert!(agent.shared.active_grant().is_none());
        assert!(
            events_of(&approvals, "ssh_agent.grant_started")
                .await
                .is_empty()
        );
    }

    #[test]
    fn only_the_grant_a_signature_started_under_counts_as_current() {
        let shared = Shared {
            key: Mutex::new(None),
            grant: Mutex::new(None),
            stopped: watch::channel(false).0,
        };
        let first = grant(300_000);
        *lock(&shared.grant) = Some(first.clone());
        assert!(shared.is_current(&first));
        // Replaced by another grant, as when a second approval allows longer.
        let second = grant(600_000);
        *lock(&shared.grant) = Some(second.clone());
        assert!(!shared.is_current(&first));
        assert!(shared.is_current(&second));
        shared.drop_grant();
        assert!(!shared.is_current(&second));
    }

    #[tokio::test]
    async fn a_grant_whose_start_cant_be_recorded_is_dropped_but_the_signature_goes_ahead() {
        let approvals = approvals().await;
        // Never migrated, so every append to it fails.
        let unusable = crate::store::Store::connect_lazy(
            &crate::store::testing::test_database_url(),
            "never_migrated",
        )
        .unwrap();
        let mut agent = VaultAgent::new(
            &[3u8; 32],
            approvals.clone(),
            EventLog::new(unusable),
            Duration::from_secs(5),
        );
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move { answer_next_allowing(&approvals, true, Some(Duration::from_secs(300))).await }
        });
        agent
            .sign(request(&agent, sshsig_blob("git")))
            .await
            .unwrap();
        answer.await.unwrap();
        assert!(agent.shared.active_grant().is_none());
    }

    #[tokio::test]
    async fn a_grant_of_the_full_limit_is_allowed_and_no_longer() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move {
                let pending = next_pending(&approvals).await;
                approvals
                    .answer(&pending.id, "device", true, Some(MAX_GRANT))
                    .await
                    .unwrap();
            }
        });
        agent
            .sign(request(&agent, sshsig_blob("git")))
            .await
            .unwrap();
        answer.await.unwrap();
        let grant = agent.shared.active_grant().unwrap();
        assert!(grant.expires_at_ms <= now_ms() + MAX_GRANT.as_millis() as i64);
    }

    #[tokio::test]
    async fn an_approval_without_a_duration_starts_no_grant() {
        let approvals = approvals().await;
        let mut agent = agent(&approvals, Duration::from_secs(5));
        let answer = tokio::spawn({
            let approvals = approvals.clone();
            async move { answer_next(&approvals, true).await }
        });
        agent
            .sign(request(&agent, sshsig_blob("git")))
            .await
            .unwrap();
        answer.await.unwrap();
        assert!(agent.shared.active_grant().is_none());
    }

    #[test]
    fn the_socket_path_follows_the_switch() {
        let mut config = Config::default();
        assert_eq!(configured_socket(&config), None);
        config.ssh_agent.enabled = true;
        assert_eq!(
            configured_socket(&config),
            Some(config.server.data_dir.join(SOCKET_NAME))
        );
    }
}
