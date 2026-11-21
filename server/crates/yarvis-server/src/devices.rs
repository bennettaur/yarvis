//! `/api/devices`: listing devices, minting scoped tokens, and revoking.
//!
//! Revoked devices stay in the list with `revokedAt`, for the audit trail.

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::json;

use crate::AppState;
use crate::auth::fresh::Fresh;
use crate::auth::routes::SignedIn;
use crate::auth::{Admin, Authed, DeviceContext, Scope, create_device, decode_scopes};
use crate::error::{ApiError, ApiResult};
use crate::events::EventLog;
use crate::store::{Store, StoreError, now_ms};

/// Long enough for "Mike's iPhone (work profile)", short enough to show in a
/// list.
const MAX_NAME_CHARS: usize = 100;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/devices", get(list))
        .route("/api/devices/tokens", post(mint))
        .route("/api/devices/{id}", delete(revoke))
}

/// A device or passkey name, trimmed and checked.
pub fn device_name(raw: &str) -> ApiResult<String> {
    let name = raw.trim();
    if name.is_empty() {
        return Err(ApiError::bad_request("give it a name"));
    }
    if name.chars().count() > MAX_NAME_CHARS || name.chars().any(char::is_control) {
        return Err(ApiError::bad_request(format!(
            "names are at most {MAX_NAME_CHARS} characters, with no control characters"
        )));
    }
    Ok(name.to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct DeviceRow {
    /// `deviceId`, as in `/api/devices/me`, sign-in and the device events.
    device_id: String,
    name: String,
    kind: String,
    scopes: Vec<Scope>,
    passkey_id: Option<String>,
    created_by: Option<String>,
    user_agent: Option<String>,
    created_at: i64,
    last_seen_at: Option<i64>,
    verified_at: Option<i64>,
    revoked_at: Option<i64>,
    /// The device making this request.
    current: bool,
}

async fn list(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
) -> ApiResult<Json<Vec<DeviceRow>>> {
    let rows = state
        .store
        .call(move |conn| {
            let mut stmt = conn.prepare(
                "SELECT id, name, kind, scopes, passkey_id, created_by, user_agent,
                        created_at, last_seen_at, verified_at, revoked_at
                 FROM devices ORDER BY created_at",
            )?;
            let rows = stmt.query_map([], |row| {
                let id: String = row.get(0)?;
                Ok(DeviceRow {
                    current: id == device.device_id,
                    device_id: id,
                    name: row.get(1)?,
                    kind: row.get(2)?,
                    scopes: decode_scopes(&row.get::<_, String>(3)?),
                    passkey_id: row.get(4)?,
                    created_by: row.get(5)?,
                    user_agent: row.get(6)?,
                    created_at: row.get(7)?,
                    last_seen_at: row.get(8)?,
                    verified_at: row.get(9)?,
                    revoked_at: row.get(10)?,
                })
            })?;
            rows.collect()
        })
        .await?;
    Ok(Json(rows))
}

#[derive(Deserialize)]
struct MintBody {
    name: String,
    scopes: Vec<Scope>,
}

async fn mint(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<MintBody>,
) -> ApiResult<Json<SignedIn>> {
    let name = device_name(&body.name)?;
    let scopes = normalize_scopes(body.scopes);
    if scopes.is_empty() {
        return Err(ApiError::bad_request("a token needs at least one scope"));
    }
    // An admin token could revoke the owner's devices, and a terminal token
    // is a shell on the server. Only the CLI on the server machine may make
    // either, since whoever runs it already has both.
    if let Some(scope) = scopes
        .iter()
        .find(|s| matches!(s, Scope::Admin | Scope::Terminal))
    {
        return Err(ApiError::bad_request(format!(
            "a token made here can't have {}",
            scope.as_str()
        ))
        .with_detail("run `yarvis-server device add` on the server instead"));
    }
    let signed_in = add_token_device(
        &state.store,
        &state.events,
        &name,
        &scopes,
        Some(&device.device_id),
    )
    .await?;
    Ok(Json(signed_in))
}

/// Creates a token device and records `device.created`, attributed to the
/// device that asked for it (`None` for the `device add` command on the
/// server's own terminal).
pub async fn add_token_device(
    store: &Store,
    events: &EventLog,
    name: &str,
    scopes: &[Scope],
    created_by: Option<&str>,
) -> Result<SignedIn, StoreError> {
    let (device_id, token) = create_device(store, name, "token", scopes, created_by).await?;
    events
        .append(
            created_by,
            "device.created",
            json!({ "deviceId": device_id, "name": name, "kind": "token", "scopes": scopes }),
        )
        .await?;
    Ok(SignedIn {
        token,
        device: DeviceContext {
            device_id,
            name: name.to_string(),
            scopes: scopes.to_vec(),
            verified_at: None,
        },
    })
}

/// Drops duplicates and puts scopes in a fixed order.
fn normalize_scopes(scopes: Vec<Scope>) -> Vec<Scope> {
    Scope::ALL
        .into_iter()
        .filter(|scope| scopes.contains(scope))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Revoked {
    revoked_at: i64,
}

async fn revoke(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Path(id): Path<String>,
) -> ApiResult<Json<Revoked>> {
    let revoked_at = now_ms();
    let row_id = id.clone();
    let changed = state
        .store
        .call(move |conn| {
            conn.execute(
                "UPDATE devices SET revoked_at = ?1 WHERE id = ?2 AND revoked_at IS NULL",
                rusqlite::params![revoked_at, row_id],
            )
        })
        .await?;
    if changed == 0 {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "no such active device",
        ));
    }
    state.auth.announce_revocation(&id);
    state
        .events
        .append(
            Some(&device.device_id),
            "device.revoked",
            json!({ "deviceId": id }),
        )
        .await?;
    Ok(Json(Revoked { revoked_at }))
}

/// Parses `read,chat,terminal,approve,admin` for the `device add` command. Unlike the
/// stored form, an unknown scope here is an error: the operator typed it.
pub fn parse_scope_list(list: &str) -> Result<Vec<Scope>, String> {
    let mut scopes = Vec::new();
    for word in list.split(',').map(str::trim).filter(|w| !w.is_empty()) {
        let scope = Scope::ALL
            .into_iter()
            .find(|s| s.as_str() == word)
            .ok_or_else(|| {
                format!("unknown scope {word:?}; use read, chat, terminal, approve or admin")
            })?;
        scopes.push(scope);
    }
    let scopes = normalize_scopes(scopes);
    if scopes.is_empty() {
        return Err("give at least one scope".into());
    }
    Ok(scopes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_scope_list_is_checked_and_deduped() {
        assert_eq!(
            parse_scope_list("chat, read,chat").unwrap(),
            vec![Scope::Read, Scope::Chat]
        );
        assert!(parse_scope_list("read,root").unwrap_err().contains("root"));
        assert!(parse_scope_list(" , ").is_err());
    }

    #[test]
    fn names_are_trimmed_and_bounded() {
        assert_eq!(device_name("  phone ").unwrap(), "phone");
        assert!(device_name("   ").is_err());
        assert!(device_name("a\nb").is_err());
        assert!(device_name(&"x".repeat(MAX_NAME_CHARS + 1)).is_err());
    }
}
