//! `/api/vault/*`: status, unlock with the vault passphrase or the recovery
//! key, lock, and changing the passphrase or the recovery key. Every route
//! answers 404 unless `secrets.backend = "vault"`.
//!
//! The vault passphrase is not the sign-in passphrase. Sign-in proves who is
//! asking; the vault passphrase is what decrypts `vault.json`, which anyone
//! with a copy of the file can attack offline, so it gets its own, stronger
//! stretching and is never stored anywhere.
//!
//! Unlocking and locking need `admin`. Changing the passphrase or the recovery
//! key also needs a fresh device, since either is a lasting way in.

use axum::extract::{Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use zeroize::Zeroizing;

use super::{Proof, RecoveryKey, VaultError, WrapperKind};
use crate::AppState;
use crate::auth::account::check_passphrase_shape;
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
        .route("/api/vault/unlock", post(unlock))
        .route("/api/vault/unlock/recovery", post(unlock_recovery))
        .route("/api/vault/passphrase", post(change_passphrase))
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
        VaultError::WrongKey => {
            ApiError::new(StatusCode::UNAUTHORIZED, "that key doesn't open the vault")
        }
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
                WrapperKind::Passphrase { .. } => "passphrase",
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

fn wait_before_guessing(left: std::time::Duration) -> ApiError {
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "wait before trying again").with_detail(format!(
        "after a wrong vault passphrase, the next try waits; {}s left",
        left.as_secs().max(1)
    ))
}

#[derive(Deserialize)]
struct PassphraseBody {
    passphrase: Zeroizing<String>,
}

async fn unlock(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
    Json(body): Json<PassphraseBody>,
) -> ApiResult<Json<Value>> {
    if let Some(left) = state.vault.guess_delay() {
        return Err(wait_before_guessing(left));
    }
    let vault = state.vault.clone();
    tokio::task::spawn_blocking(move || vault.unlock_with_passphrase(&body.passphrase))
        .await
        .map_err(ApiError::internal)?
        .map_err(vault_error)?;
    after_unlock(&state, &device.device_id, json!({ "via": "passphrase" })).await
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePassphrase {
    current_passphrase: Option<Zeroizing<String>>,
    recovery_key: Option<Zeroizing<String>>,
    new_passphrase: Zeroizing<String>,
}

/// Re-wraps the vault key under a new passphrase. The current passphrase or
/// the recovery key proves the change is the owner's, since a fresh device
/// alone is a sign-in, not knowledge of the vault.
async fn change_passphrase(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<ChangePassphrase>,
) -> ApiResult<Json<Value>> {
    check_passphrase_shape(&body.new_passphrase).map_err(ApiError::bad_request)?;
    let recovery = match &body.recovery_key {
        Some(key) => Some(
            RecoveryKey::parse(key)
                .map_err(|_| ApiError::bad_request("that isn't a recovery key"))?,
        ),
        None => None,
    };
    if body.current_passphrase.is_some() == recovery.is_some() {
        return Err(ApiError::bad_request(
            "send the current passphrase or the recovery key",
        ));
    }
    if body.current_passphrase.is_some()
        && let Some(left) = state.vault.guess_delay()
    {
        return Err(wait_before_guessing(left));
    }
    let vault = state.vault.clone();
    tokio::task::spawn_blocking(move || {
        let proof = match (&body.current_passphrase, &recovery) {
            (Some(current), _) => Proof::Passphrase(current),
            (None, Some(recovery)) => Proof::Recovery(recovery),
            (None, None) => unreachable!("checked above"),
        };
        vault.change_passphrase(proof, &body.new_passphrase)
    })
    .await
    .map_err(ApiError::internal)?
    .map_err(vault_error)?;
    state
        .events
        .append(
            Some(&device.device_id),
            "vault.passphrase_changed",
            json!({}),
        )
        .await?;
    Ok(Json(json!({ "state": "unlocked" })))
}

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
