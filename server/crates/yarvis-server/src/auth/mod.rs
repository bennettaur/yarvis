//! Who is asking. Every request but sign-in carries a device token, and every
//! route names the scope it needs with an [`Authed`] extractor.
//!
//! A token is 32 random bytes, sent as base64url. Only its SHA-256 is stored,
//! so a copy of the database doesn't let anyone sign in. The token is looked
//! up on every request, which is what makes revoking a device take effect at
//! once.

use std::marker::PhantomData;
use std::time::Duration;

use axum::extract::ws::{Message, WebSocket};
use axum::extract::{FromRef, FromRequestParts};
use axum::http::header::AUTHORIZATION;
use axum::http::request::Parts;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use rand::RngCore;
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::broadcast;

pub mod account;
pub mod fresh;
pub mod routes;
pub mod setup_code;
pub mod totp;

use crate::error::ApiError;
use crate::store::{Store, StoreError, now_ms};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// See data and events.
    Read,
    /// Send chat messages and act through the sidecar.
    Chat,
    /// Open and type into PTY sessions: a shell as the server's user, which
    /// reaches the secrets store and the control socket. Kept apart from
    /// `chat` so a chat bot's token doesn't come with a shell.
    Terminal,
    /// Answer approvals, including git signatures.
    Approve,
    /// Manage devices, the vault and secrets.
    Admin,
}

impl Scope {
    pub const ALL: [Scope; 5] = [
        Scope::Read,
        Scope::Chat,
        Scope::Terminal,
        Scope::Approve,
        Scope::Admin,
    ];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Chat => "chat",
            Scope::Terminal => "terminal",
            Scope::Approve => "approve",
            Scope::Admin => "admin",
        }
    }

    fn parse(s: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|scope| scope.as_str() == s)
    }
}

/// Scopes are stored as a space-separated list.
pub fn encode_scopes(scopes: &[Scope]) -> String {
    scopes
        .iter()
        .map(|s| s.as_str())
        .collect::<Vec<_>>()
        .join(" ")
}

pub fn decode_scopes(s: &str) -> Vec<Scope> {
    s.split_whitespace().filter_map(Scope::parse).collect()
}

/// The device a request came from.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceContext {
    pub device_id: String,
    pub name: String,
    pub scopes: Vec<Scope>,
    /// When this device last signed in or entered a TOTP code, in ms since
    /// the epoch. Admin actions want this to be recent.
    pub verified_at: Option<i64>,
}

impl DeviceContext {
    pub fn has(&self, scope: Scope) -> bool {
        self.scopes.contains(&scope)
    }
}

/// Auth state shared by every route.
#[derive(Clone)]
pub struct Auth {
    store: Store,
    /// Carries the id of each device as it is revoked, so open WebSockets
    /// belonging to it can close.
    revoked: broadcast::Sender<String>,
}

impl Auth {
    pub fn new(store: Store) -> Self {
        let (revoked, _) = broadcast::channel(64);
        Self { store, revoked }
    }

    pub fn store(&self) -> &Store {
        &self.store
    }

    pub fn subscribe_revocations(&self) -> broadcast::Receiver<String> {
        self.revoked.subscribe()
    }

    /// Tells open connections that `device_id` was revoked. The caller has
    /// already set `revoked_at`.
    pub fn announce_revocation(&self, device_id: &str) {
        let _ = self.revoked.send(device_id.to_string());
    }

    /// Announces revocations another process wrote, such as
    /// `yarvis-server auth reset --sign-out-all`, so their sockets close
    /// within [`OUTSIDE_REVOCATION_POLL`]. Requests already refuse a revoked
    /// token, since every one reads the row. In-process revocations are seen
    /// again here, which is harmless.
    pub fn watch_outside_revocations(&self) -> tokio::task::JoinHandle<()> {
        let auth = self.clone();
        tokio::spawn(async move {
            let mut since = now_ms();
            let mut announced_at_since = std::collections::HashSet::new();
            loop {
                tokio::time::sleep(OUTSIDE_REVOCATION_POLL).await;
                let from = since;
                let rows = auth
                    .store
                    .call(move |conn| {
                        let mut stmt = conn
                            .prepare("SELECT id, revoked_at FROM devices WHERE revoked_at >= ?1")?;
                        stmt.query_map([from], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?
                            .collect::<rusqlite::Result<Vec<(String, i64)>>>()
                    })
                    .await;
                let rows = match rows {
                    Ok(rows) => rows,
                    Err(e) => {
                        tracing::warn!("couldn't check for revoked devices: {e}");
                        continue;
                    }
                };
                // Rows at `since` were announced last time; anything later is new.
                let latest = rows.iter().map(|(_, at)| *at).max().unwrap_or(since);
                if latest > since {
                    announced_at_since.clear();
                }
                for (id, at) in rows {
                    if at == since && announced_at_since.contains(&id) {
                        continue;
                    }
                    auth.announce_revocation(&id);
                    if at == latest {
                        announced_at_since.insert(id);
                    }
                }
                since = latest;
            }
        })
    }

    /// Looks up a live device by its token and records that it was seen.
    pub async fn authenticate(&self, token: &str) -> Result<Option<DeviceContext>, StoreError> {
        let Some(raw) = URL_SAFE_NO_PAD.decode(token).ok() else {
            return Ok(None);
        };
        let hash = Sha256::digest(&raw).to_vec();
        self.store
            .call(move |conn| {
                let device = conn
                    .query_row(
                        "SELECT id, name, scopes, verified_at FROM devices
                         WHERE token_hash = ?1 AND revoked_at IS NULL
                           AND COALESCE(last_seen_at, created_at) > ?2",
                        rusqlite::params![hash, now_ms() - IDLE_EXPIRY_MS],
                        |row| {
                            Ok(DeviceContext {
                                device_id: row.get(0)?,
                                name: row.get(1)?,
                                scopes: decode_scopes(&row.get::<_, String>(2)?),
                                verified_at: row.get(3)?,
                            })
                        },
                    )
                    .optional()?;
                if let Some(device) = &device {
                    // Throttled, so a busy client doesn't turn every read into a write.
                    let now = now_ms();
                    conn.execute(
                        "UPDATE devices SET last_seen_at = ?1
                         WHERE id = ?2 AND (last_seen_at IS NULL OR last_seen_at < ?3)",
                        rusqlite::params![now, device.device_id, now - LAST_SEEN_RESOLUTION_MS],
                    )?;
                }
                Ok(device)
            })
            .await
    }
}

/// A new random token and the hash to store for it.
pub fn new_token() -> (String, Vec<u8>) {
    let mut raw = [0u8; 32];
    rand::rng().fill_bytes(&mut raw);
    (URL_SAFE_NO_PAD.encode(raw), Sha256::digest(raw).to_vec())
}

pub fn new_id() -> String {
    let mut raw = [0u8; 16];
    rand::rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

/// A scope a route can require, as a type so the route's signature says it.
pub trait ScopeMarker: Send + Sync + 'static {
    const SCOPE: Scope;
}

pub struct Read;
pub struct Chat;
pub struct Terminal;
pub struct Approve;
pub struct Admin;

impl ScopeMarker for Read {
    const SCOPE: Scope = Scope::Read;
}
impl ScopeMarker for Chat {
    const SCOPE: Scope = Scope::Chat;
}
impl ScopeMarker for Terminal {
    const SCOPE: Scope = Scope::Terminal;
}
impl ScopeMarker for Approve {
    const SCOPE: Scope = Scope::Approve;
}
impl ScopeMarker for Admin {
    const SCOPE: Scope = Scope::Admin;
}

/// Extracts the calling device and rejects the request unless it holds `S`.
pub struct Authed<S: ScopeMarker> {
    pub device: DeviceContext,
    _scope: PhantomData<S>,
}

impl<S, St> FromRequestParts<St> for Authed<S>
where
    S: ScopeMarker,
    Auth: FromRef<St>,
    St: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &St) -> Result<Self, Self::Rejection> {
        let device = bearer_device(parts, state).await?;
        if !device.has(S::SCOPE) {
            return Err(ApiError::forbidden(format!(
                "this device doesn't have the {} scope",
                S::SCOPE.as_str()
            )));
        }
        Ok(Self {
            device,
            _scope: PhantomData,
        })
    }
}

/// Extracts the calling device whatever its scopes, for the few routes any
/// valid token may call, such as signing itself out.
pub struct AnyDevice {
    pub device: DeviceContext,
}

impl<St> FromRequestParts<St> for AnyDevice
where
    Auth: FromRef<St>,
    St: Send + Sync,
{
    type Rejection = ApiError;

    async fn from_request_parts(parts: &mut Parts, state: &St) -> Result<Self, Self::Rejection> {
        Ok(Self {
            device: bearer_device(parts, state).await?,
        })
    }
}

/// The live device the request's bearer token names, or 401.
async fn bearer_device<St>(parts: &Parts, state: &St) -> Result<DeviceContext, ApiError>
where
    Auth: FromRef<St>,
{
    let token = parts
        .headers
        .get(AUTHORIZATION)
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.strip_prefix("Bearer "))
        .ok_or_else(ApiError::unauthorized)?;
    Auth::from_ref(state)
        .authenticate(token)
        .await?
        .ok_or_else(ApiError::unauthorized)
}

/// A token unused for this long stops working, so one left behind in a
/// forgotten browser profile doesn't stay valid for good.
pub const IDLE_EXPIRY_MS: i64 = 90 * 24 * 60 * 60 * 1000;

/// How often the server looks for revocations made by another process.
const OUTSIDE_REVOCATION_POLL: Duration = Duration::from_secs(2);

/// How stale `last_seen_at` may get. It's for the devices list, not security.
const LAST_SEEN_RESOLUTION_MS: i64 = 60_000;

/// How long a new WebSocket has to send its auth message.
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// The first message on every WebSocket. Browsers can't set headers on a
/// WebSocket, and a token in the URL ends up in logs, so it comes here.
/// Routes read their own extra fields (`since`, `offset`) from `extra`.
#[derive(Deserialize)]
pub struct WsHello {
    #[serde(rename = "type")]
    pub kind: String,
    pub token: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

// Written by hand so the token never reaches a log through `{:?}`.
impl std::fmt::Debug for WsHello {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WsHello")
            .field("kind", &self.kind)
            .field("token", &"<redacted>")
            .field("extra", &self.extra)
            .finish()
    }
}

/// Why the server closed a WebSocket. The codes sit in the private-use range
/// and mirror HTTP statuses, so a client can tell "sign in again" (4401) from
/// a server fault (1011) it should retry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CloseReason {
    /// No auth message, a bad or revoked token, or the device was revoked
    /// while connected.
    Unauthorized,
    /// The device lacks the route's scope.
    Forbidden,
    /// A message the route can't use, such as a malformed `since`.
    BadRequest,
    /// The server failed. Reconnect and try again.
    Internal,
}

impl CloseReason {
    pub fn code(self) -> u16 {
        match self {
            Self::Unauthorized => 4401,
            Self::Forbidden => 4403,
            Self::BadRequest => 4400,
            Self::Internal => 1011,
        }
    }

    fn text(self) -> &'static str {
        match self {
            Self::Unauthorized => "sign in first",
            Self::Forbidden => "missing scope",
            Self::BadRequest => "bad request",
            Self::Internal => "internal error",
        }
    }
}

/// Reads the auth message from a new WebSocket and checks the device holds
/// `scope`. On failure the socket gets a close frame and the caller returns.
/// Callers should cap the upgrade's `max_message_size`, since this parses the
/// first message before anyone is authenticated.
pub async fn authenticate_ws(
    socket: &mut WebSocket,
    auth: &Auth,
    scope: Scope,
) -> Option<(DeviceContext, WsHello)> {
    let first = tokio::time::timeout(WS_AUTH_TIMEOUT, socket.recv()).await;
    let hello = match first {
        Ok(Some(Ok(Message::Text(text)))) => serde_json::from_str::<WsHello>(&text).ok(),
        _ => None,
    };
    let Some(hello) = hello.filter(|h| h.kind == "auth") else {
        close(socket, CloseReason::Unauthorized).await;
        return None;
    };
    let device = match auth.authenticate(&hello.token).await {
        Ok(Some(device)) => device,
        Ok(None) => {
            close(socket, CloseReason::Unauthorized).await;
            return None;
        }
        Err(e) => {
            tracing::error!("websocket auth failed: {e}");
            close(socket, CloseReason::Internal).await;
            return None;
        }
    };
    if !device.has(scope) {
        close(socket, CloseReason::Forbidden).await;
        return None;
    }
    Some((device, hello))
}

pub async fn close(socket: &mut WebSocket, reason: CloseReason) {
    use axum::extract::ws::CloseFrame;
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code: reason.code(),
            reason: reason.text().into(),
        })))
        .await;
}

/// Inserts a device and returns its token. Used by sign-in, by token minting,
/// and by tests.
pub async fn create_device(
    store: &Store,
    name: &str,
    kind: &str,
    scopes: &[Scope],
    created_by: Option<&str>,
) -> Result<(String, String), StoreError> {
    let (token, hash) = new_token();
    let id = new_id();
    let (name, kind, scopes, created_by) = (
        name.to_string(),
        kind.to_string(),
        encode_scopes(scopes),
        created_by.map(str::to_string),
    );
    let device_id = id.clone();
    store
        .call(move |conn| {
            conn.execute(
                "INSERT INTO devices (id, name, kind, scopes, token_hash, created_by, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                rusqlite::params![id, name, kind, scopes, hash, created_by, now_ms()],
            )
        })
        .await?;
    Ok((device_id, token))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_token_finds_its_device_and_a_wrong_one_finds_nothing() {
        let store = Store::open_in_memory().unwrap();
        let auth = Auth::new(store.clone());
        let (id, token) = create_device(&store, "laptop", "token", &[Scope::Read], None)
            .await
            .unwrap();
        let device = auth.authenticate(&token).await.unwrap().unwrap();
        assert_eq!(device.device_id, id);
        assert_eq!(device.scopes, vec![Scope::Read]);
        let (other, _) = new_token();
        assert!(auth.authenticate(&other).await.unwrap().is_none());
        assert!(auth.authenticate("not base64!").await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_revoked_device_is_refused() {
        let store = Store::open_in_memory().unwrap();
        let auth = Auth::new(store.clone());
        let (id, token) = create_device(&store, "phone", "token", &Scope::ALL, None)
            .await
            .unwrap();
        store
            .call(move |conn| conn.execute("UPDATE devices SET revoked_at = 1 WHERE id = ?1", [id]))
            .await
            .unwrap();
        assert!(auth.authenticate(&token).await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_token_idle_past_the_expiry_is_refused() {
        let store = Store::open_in_memory().unwrap();
        let auth = Auth::new(store.clone());
        let (id, token) = create_device(&store, "old", "token", &[Scope::Read], None)
            .await
            .unwrap();
        let long_ago = now_ms() - IDLE_EXPIRY_MS - 1;
        store
            .call(move |conn| {
                conn.execute(
                    "UPDATE devices SET created_at = ?1, last_seen_at = ?1 WHERE id = ?2",
                    rusqlite::params![long_ago, id],
                )
            })
            .await
            .unwrap();
        assert!(auth.authenticate(&token).await.unwrap().is_none());
    }

    #[test]
    fn unknown_scopes_are_dropped_rather_than_granted() {
        assert_eq!(
            decode_scopes("read root admin"),
            vec![Scope::Read, Scope::Admin]
        );
    }
}
