//! `/api/vault/*`: status, unlock with the recovery key, and lock. Every
//! route answers 404 unless `secrets.backend = "vault"`.
//!
//! Unlocking and locking need `admin`. Replacing the recovery key also needs
//! a fresh device, since the new key is a lasting way in.

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{RecoveryKey, VaultError, WrapperKind};
use crate::AppState;
use crate::auth::fresh::Fresh;
use crate::auth::{Admin, Authed, Read};
use crate::config::SecretBackendKind;
use crate::error::{ApiError, ApiResult};
use crate::ssh_agent;

pub fn router(state: &AppState) -> Router<AppState> {
    // The unlock routes aren't rate-limited: they need an admin token, and
    // the shared per-address budget is charged before auth, so anyone could
    // spend it and block the owner's unlock.
    Router::new()
        .route("/api/vault/status", get(status))
        .route("/api/vault/unlock/recovery", post(unlock_recovery))
        .route("/api/vault/lock", post(lock))
        .route("/api/vault/recovery-key", post(rotate_recovery_key))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            only_with_vault,
        ))
}

async fn only_with_vault(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.config.secrets.backend != Some(SecretBackendKind::Vault) {
        return ApiError::not_found().into_response();
    }
    next.run(request).await
}

fn vault_error(e: VaultError) -> ApiError {
    match e {
        VaultError::Locked => {
            ApiError::conflict("the vault is locked").with_detail("unlock it first")
        }
        VaultError::AlreadyUnlocked => ApiError::conflict("the vault is already unlocked"),
        VaultError::Uninitialized => ApiError::conflict("there is no vault yet")
            .with_detail("run `yarvis-server vault init` on the server"),
        VaultError::WrongKey | VaultError::NoMatchingWrapper => {
            ApiError::new(StatusCode::UNAUTHORIZED, "that key doesn't open the vault")
        }
        VaultError::LastWrapper => ApiError::conflict("that is the vault's last unlock method")
            .with_detail("add another before removing this one"),
        other => ApiError::internal(other),
    }
}

// ---- status ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WrapperRow {
    id: String,
    label: String,
    /// The API's name for the wrapper's kind, not the file's tag.
    kind: &'static str,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    state: &'static str,
    wrappers: Vec<WrapperRow>,
}

async fn status(State(state): State<AppState>, _: Authed<Read>) -> ApiResult<Json<Status>> {
    let vault_state = state.vault.state().map_err(vault_error)?;
    let wrappers = match state.vault.wrappers() {
        Ok(wrappers) => wrappers,
        Err(VaultError::Uninitialized) => Vec::new(),
        Err(e) => return Err(vault_error(e)),
    };
    let rows = wrappers
        .into_iter()
        .map(|wrapper| WrapperRow {
            kind: match wrapper.kind {
                WrapperKind::Recovery => "recovery",
            },
            id: wrapper.id,
            label: wrapper.label,
        })
        .collect();
    Ok(Json(Status {
        state: vault_state.as_str(),
        wrappers: rows,
    }))
}

// ---- unlock ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RecoveryBody {
    recovery_key: Zeroizing<String>,
}

async fn unlock_recovery(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
    Json(body): Json<RecoveryBody>,
) -> ApiResult<Json<Value>> {
    let recovery = RecoveryKey::parse(&body.recovery_key)
        .map_err(|_| ApiError::bad_request("that isn't a recovery key"))?;
    state
        .vault
        .unlock_with_recovery(&recovery)
        .map_err(vault_error)?;
    after_unlock(&state, &device.device_id, json!({ "via": "recovery" })).await
}

/// Everything that follows an unlock: the ssh-agent, when it is on, and the
/// event. An agent that can't start leaves the vault unlocked, since the
/// secrets are still needed; its status route shows it isn't running.
async fn after_unlock(state: &AppState, device_id: &str, data: Value) -> ApiResult<Json<Value>> {
    if let Err(e) = ssh_agent::start(state) {
        tracing::error!("the vault is unlocked but the ssh-agent didn't start: {e}");
    }
    state
        .events
        .append(Some(device_id), "vault.unlocked", data)
        .await?;
    Ok(Json(json!({ "state": "unlocked" })))
}

// ---- lock ----

async fn lock(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
) -> ApiResult<Json<Value>> {
    if ssh_agent::stop_and_lock(&state) {
        state
            .events
            .append(Some(&device.device_id), "vault.locked", json!({}))
            .await?;
    }
    Ok(Json(json!({ "state": "locked" })))
}

// ---- the recovery key ----

/// Makes a new recovery key and returns it, once. The old one stops working.
async fn rotate_recovery_key(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
) -> ApiResult<Json<Value>> {
    let recovery = state.vault.rotate_recovery_key().map_err(vault_error)?;
    state
        .events
        .append(
            Some(&device.device_id),
            "vault.recovery_key_rotated",
            json!({}),
        )
        .await?;
    Ok(Json(json!({ "recoveryKey": recovery.expose() })))
}
