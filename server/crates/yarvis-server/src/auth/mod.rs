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

use crate::error::ApiError;
use crate::store::{Store, StoreError, now_ms};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// See data and events.
    Read,
    /// Send chat messages and drive PTY sessions.
    Chat,
    /// Answer approvals, including git signatures.
    Approve,
    /// Manage devices, the vault and secrets.
    Admin,
}

impl Scope {
    pub const ALL: [Scope; 4] = [Scope::Read, Scope::Chat, Scope::Approve, Scope::Admin];

    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Chat => "chat",
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
    /// When this device last passed a passkey check, in ms since the epoch.
    /// Admin actions want this to be recent.
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
                         WHERE token_hash = ?1 AND revoked_at IS NULL",
                        [&hash],
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
                    conn.execute(
                        "UPDATE devices SET last_seen_at = ?1 WHERE id = ?2",
                        rusqlite::params![now_ms(), device.device_id],
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
pub struct Approve;
pub struct Admin;

impl ScopeMarker for Read {
    const SCOPE: Scope = Scope::Read;
}
impl ScopeMarker for Chat {
    const SCOPE: Scope = Scope::Chat;
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
        let token = parts
            .headers
            .get(AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .and_then(|v| v.strip_prefix("Bearer "))
            .ok_or_else(ApiError::unauthorized)?;
        let device = Auth::from_ref(state)
            .authenticate(token)
            .await?
            .ok_or_else(ApiError::unauthorized)?;
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

/// How long a new WebSocket has to send its auth message.
const WS_AUTH_TIMEOUT: Duration = Duration::from_secs(10);

/// The first message on every WebSocket. Browsers can't set headers on a
/// WebSocket, and a token in the URL ends up in logs, so it comes here.
/// Routes read their own extra fields (`since`, `offset`) from `extra`.
#[derive(Debug, Deserialize)]
pub struct WsHello {
    #[serde(rename = "type")]
    pub kind: String,
    pub token: String,
    #[serde(flatten)]
    pub extra: serde_json::Map<String, serde_json::Value>,
}

/// Reads the auth message from a new WebSocket and checks the device holds
/// `scope`. On failure the socket gets a close frame with the reason and the
/// caller just returns.
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
        close(socket, "send {\"type\":\"auth\",\"token\":...} first").await;
        return None;
    };
    let device = match auth.authenticate(&hello.token).await {
        Ok(Some(device)) => device,
        Ok(None) => {
            close(socket, "sign in first").await;
            return None;
        }
        Err(e) => {
            tracing::error!("websocket auth failed: {e}");
            close(socket, "internal error").await;
            return None;
        }
    };
    if !device.has(scope) {
        close(socket, "missing scope").await;
        return None;
    }
    Some((device, hello))
}

async fn close(socket: &mut WebSocket, reason: &str) {
    use axum::extract::ws::CloseFrame;
    // 4401/4403 mirror HTTP 401/403 in the private-use close code range.
    let code = if reason == "missing scope" {
        4403
    } else {
        4401
    };
    let _ = socket
        .send(Message::Close(Some(CloseFrame {
            code,
            reason: reason.into(),
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

    #[test]
    fn unknown_scopes_are_dropped_rather_than_granted() {
        assert_eq!(
            decode_scopes("read root admin"),
            vec![Scope::Read, Scope::Admin]
        );
    }
}
