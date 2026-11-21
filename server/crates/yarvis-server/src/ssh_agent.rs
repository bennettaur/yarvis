//! The server's own ssh-agent, for signing git commits with the vault's
//! Ed25519 key. Off unless `ssh_agent.enabled` is set: a work laptop keeps
//! its signing key in 1Password, and then nothing here runs, makes a key or
//! opens a socket.
//!
//! When on, the agent listens on `ssh-agent.sock` in the data dir while the
//! vault is unlocked, and stops (removing the socket) when it locks. It signs
//! only SSHSIG blobs in the `git` namespace, so the key can't log in to a
//! host, and every signature waits for an answer on the approvals route.

use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use axum::extract::{Request, State};
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
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
use crate::approvals::Approvals;
use crate::auth::{Authed, Read};
use crate::config::Config;
use crate::error::{ApiError, ApiResult};

/// The approval kind a signature request is filed under.
pub const APPROVAL_KIND: &str = "git.sign";

/// How long a signature waits for an answer. `git commit` blocks meanwhile.
pub const APPROVAL_TIMEOUT: Duration = Duration::from_secs(60);

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
        .then(|| config.server.data_dir.join(SOCKET_NAME))
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
    let agent = VaultAgent::new(&seed, state.approvals.clone(), APPROVAL_TIMEOUT);
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
    timeout: Duration,
}

struct Shared {
    key: Mutex<Option<Ed25519Keypair>>,
    stopped: watch::Sender<bool>,
}

impl Shared {
    /// Drops the key, which zeroizes it, and wakes every waiting signature.
    fn stop(&self) {
        lock(&self.key).take();
        self.stopped.send_replace(true);
    }
}

impl VaultAgent {
    pub fn new(seed: &[u8; 32], approvals: Approvals, timeout: Duration) -> Self {
        let key = Ed25519Keypair::from_seed(seed);
        Self {
            public: key.public,
            shared: Arc::new(Shared {
                key: Mutex::new(Some(key)),
                stopped: watch::channel(false).0,
            }),
            approvals,
            timeout,
        }
    }

    pub fn public_key(&self) -> PublicKey {
        PublicKey::new(KeyData::Ed25519(self.public), KEY_COMMENT)
    }

    /// Asks the approvals route. A denial, a timeout, a failure to ask, or the
    /// agent stopping meanwhile is a refusal.
    async fn approve(&self, hash_alg: &str) -> bool {
        let fingerprint = self.public_key().fingerprint(HashAlg::Sha256).to_string();
        // SSHSIG carries only a hash of the commit, so the key is all there
        // is to show.
        let summary = format!("Sign a git commit or tag with {fingerprint}");
        let detail = json!({
            "namespace": "git",
            "keyFingerprint": fingerprint,
            "hashAlgorithm": hash_alg,
        });
        let mut stopped = self.shared.stopped.subscribe();
        // Dropping the request when the agent stops settles the approval as
        // abandoned, so a late "yes" can't land.
        tokio::select! {
            decision = self.approvals.request(APPROVAL_KIND, &summary, detail, self.timeout) => {
                match decision {
                    Ok(decision) => decision.approved(),
                    Err(e) => {
                        tracing::error!("couldn't ask for a signature approval: {e}");
                        false
                    }
                }
            }
            _ = stopped.wait_for(|stopped| *stopped) => false,
        }
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
        if !self.approve(hash_alg).await {
            return Err(refuse("signature denied"));
        }
        let key = lock(&self.shared.key);
        let key = key.as_ref().ok_or_else(|| refuse("the vault is locked"))?;
        key.try_sign(&request.data).map_err(AgentError::other)
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

/// `GET /api/vault/ssh-agent`, which answers 404 when the agent is off.
pub fn router(state: &AppState) -> Router<AppState> {
    Router::new()
        .route("/api/vault/ssh-agent", get(status))
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
}

async fn status(State(state): State<AppState>, _: Authed<Read>) -> ApiResult<Json<Status>> {
    let running = state.ssh_agent.is_running();
    Ok(Json(Status {
        enabled: true,
        public_key: state.ssh_agent.public_key(),
        socket_path: socket_path(&state)
            .filter(|_| running)
            .map(|p| p.display().to_string()),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::approvals::Approvals;
    use crate::events::EventLog;
    use crate::store::Store;

    fn sshsig_blob(namespace: &str) -> Vec<u8> {
        let mut blob = b"SSHSIG".to_vec();
        for field in [namespace.as_bytes(), b"", b"sha512", &[0u8; 64]] {
            blob.extend_from_slice(&(field.len() as u32).to_be_bytes());
            blob.extend_from_slice(field);
        }
        blob
    }

    fn approvals() -> Approvals {
        let store = Store::open_in_memory().unwrap();
        Approvals::new(store.clone(), EventLog::new(store))
    }

    fn agent(approvals: &Approvals, timeout: Duration) -> VaultAgent {
        VaultAgent::new(&[3u8; 32], approvals.clone(), timeout)
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
        let pending = next_pending(approvals).await;
        approvals
            .answer(&pending.id, "device", approve)
            .await
            .unwrap();
        pending
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
        let approvals = approvals();
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
        let approvals = approvals();
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
        let approvals = approvals();
        let mut agent = agent(&approvals, Duration::from_millis(50));
        let req = request(&agent, sshsig_blob("git"));
        assert!(agent.sign(req).await.is_err());
        assert!(approvals.pending().await.unwrap().is_empty());
    }

    #[tokio::test]
    async fn non_git_data_is_refused_before_anyone_is_asked() {
        let approvals = approvals();
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
        let approvals = approvals();
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
        let approvals = approvals();
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
