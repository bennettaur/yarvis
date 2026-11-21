//! `/api/vault/*`: status, unlock with a passkey's PRF output or the recovery
//! key, lock, and the passkey wrappers. Every route answers 404 unless
//! `secrets.backend = "vault"`.
//!
//! webauthn-rs has no PRF support, so the options it builds are patched to
//! add `extensions.prf`, and the client sends the PRF result beside the
//! credential as `prfFirst` (base64url). The result isn't signed: it proves
//! itself only by opening a wrapper, and is used only after webauthn-rs has
//! verified the assertion it came with.
//!
//! Unlocking and locking need `admin`. Adding or removing a wrapper also needs
//! a fresh passkey check, since a wrapper is a lasting way back in.

use axum::extract::{Path, Request, State};
use axum::http::StatusCode;
use axum::middleware::{self, Next};
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use webauthn_rs::prelude::{
    AuthenticationResult, PasskeyAuthentication, PublicKeyCredential, RequestChallengeResponse,
};
use zeroize::Zeroizing;

use super::file::passkey_wrapper_id;
use super::{RecoveryKey, UnwrapSecret, VaultError, WrapperKind};
use crate::AppState;
use crate::auth::fresh::Fresh;
use crate::auth::passkeys::Ceremony;
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
        .route("/api/vault/unlock/start", post(unlock_start))
        .route("/api/vault/unlock/finish", post(unlock_finish))
        .route("/api/vault/unlock/recovery", post(unlock_recovery))
        .route("/api/vault/lock", post(lock))
        .route("/api/vault/wrappers/passkey/start", post(enroll_start))
        .route("/api/vault/wrappers/passkey/finish", post(enroll_finish))
        .route("/api/vault/wrappers/{id}", delete(remove_wrapper))
        .route_layer(middleware::from_fn_with_state(
            state.clone(),
            only_with_vault,
        ))
}

async fn only_with_vault(State(state): State<AppState>, request: Request, next: Next) -> Response {
    if state.config.secrets.backend != SecretBackendKind::Vault {
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
        VaultError::DuplicateWrapper(_) => {
            ApiError::conflict("that passkey can already unlock the vault")
        }
        other => ApiError::internal(other),
    }
}

const PRF_OUTPUT_LEN: usize = 32;

fn unknown_ceremony() -> ApiError {
    ApiError::bad_request("unknown or expired ceremony").with_detail("start again")
}

fn other_device() -> ApiError {
    ApiError::forbidden("this ceremony belongs to another device")
}

fn start_ceremony(state: &AppState, ceremony: Ceremony, options: Value) -> ApiResult<Json<Value>> {
    let ceremony_id = state.passkeys.start_ceremony(ceremony).ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "too many passkey prompts in progress",
        )
        .with_detail("try again in a few minutes")
    })?;
    Ok(Json(
        json!({ "ceremonyId": ceremony_id, "options": options }),
    ))
}

/// Adds `extensions.prf.evalByCredential` to webauthn-rs's assertion options:
/// each credential id (base64url) maps to `{ first: <salt, base64url> }`.
/// Clients decode the salts to bytes before calling WebAuthn.
fn with_prf(options: &RequestChallengeResponse, salts: &[(String, String)]) -> Value {
    let mut value = serde_json::to_value(options).expect("options serialize");
    let eval: serde_json::Map<String, Value> = salts
        .iter()
        .map(|(credential_id, salt)| (credential_id.clone(), json!({ "first": salt })))
        .collect();
    value["publicKey"]["extensions"]["prf"] = json!({ "evalByCredential": eval });
    value
}

/// Verifies an assertion and records the passkey's new sign count.
async fn verify(
    state: &AppState,
    credential: &PublicKeyCredential,
    auth: &PasskeyAuthentication,
) -> ApiResult<AuthenticationResult> {
    let result = state
        .passkeys
        .webauthn()
        .finish_passkey_authentication(credential, auth)
        .map_err(|e| {
            tracing::debug!("passkey check failed: {e}");
            ApiError::new(StatusCode::UNAUTHORIZED, "passkey check failed")
        })?;
    state
        .passkeys
        .record_use(&result)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "that passkey was removed"))?;
    Ok(result)
}

/// The PRF output the client sent. Missing means the browser or
/// authenticator doesn't do PRF, which the user needs told plainly.
fn prf_output(prf_first: Option<Zeroizing<String>>) -> ApiResult<UnwrapSecret> {
    let encoded = prf_first.filter(|s| !s.is_empty()).ok_or_else(|| {
        ApiError::bad_request("the browser returned no PRF output").with_detail(
            "this browser or authenticator can't unlock the vault; use the recovery key",
        )
    })?;
    // PRF outputs are 32 bytes. A shorter one would make a wrapper that
    // anyone with the file could brute-force.
    let bytes = B64
        .decode(encoded.as_bytes())
        .ok()
        .filter(|b| b.len() == PRF_OUTPUT_LEN)
        .ok_or_else(|| ApiError::bad_request("prfFirst isn't 32 bytes of base64url"))?;
    Ok(UnwrapSecret::from_bytes(bytes))
}

// ---- status ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WrapperRow {
    id: String,
    label: String,
    /// `"recovery"` or `"passkey"`: the API's names, not the file's tags.
    kind: &'static str,
    /// The passkey this wrapper belongs to, for a `passkey` wrapper whose
    /// passkey still exists.
    #[serde(skip_serializing_if = "Option::is_none")]
    passkey_id: Option<String>,
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
    let mut rows = Vec::with_capacity(wrappers.len());
    for wrapper in wrappers {
        let (kind, passkey_id) = match &wrapper.kind {
            WrapperKind::Recovery => ("recovery", None),
            WrapperKind::PasskeyPrf { credential_id, .. } => {
                let passkey = match B64.decode(credential_id) {
                    Ok(raw) => state.passkeys.passkey_by_credential_id(&raw).await?,
                    Err(_) => None,
                };
                ("passkey", passkey.map(|p| p.id))
            }
        };
        rows.push(WrapperRow {
            id: wrapper.id,
            label: wrapper.label,
            kind,
            passkey_id,
        });
    }
    Ok(Json(Status {
        state: vault_state.as_str(),
        wrappers: rows,
    }))
}

// ---- unlock ----

/// Starts an assertion offering every passkey that has a wrapper, each with
/// its own PRF salt.
async fn unlock_start(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
) -> ApiResult<Json<Value>> {
    if state.vault.is_unlocked() {
        return Err(vault_error(VaultError::AlreadyUnlocked));
    }
    let salts: Vec<(String, String)> = state
        .vault
        .wrappers()
        .map_err(vault_error)?
        .into_iter()
        .filter_map(|w| match w.kind {
            WrapperKind::PasskeyPrf {
                credential_id,
                prf_salt,
            } => Some((credential_id, prf_salt)),
            WrapperKind::Recovery => None,
        })
        .collect();
    let passkeys: Vec<_> = state
        .passkeys
        .passkeys()
        .await?
        .into_iter()
        .map(|p| p.passkey)
        .filter(|p| {
            let id = B64.encode(p.cred_id().as_slice());
            salts.iter().any(|(credential_id, _)| *credential_id == id)
        })
        .collect();
    if passkeys.is_empty() {
        return Err(ApiError::conflict("no passkey can unlock the vault yet")
            .with_detail("unlock with the recovery key, then add a passkey to the vault"));
    }
    let (options, auth) = state
        .passkeys
        .webauthn()
        .start_passkey_authentication(&passkeys)
        .map_err(ApiError::internal)?;
    start_ceremony(
        &state,
        Ceremony::VaultUnlock {
            auth,
            device_id: device.device_id,
        },
        with_prf(&options, &salts),
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PrfFinish {
    ceremony_id: String,
    credential: PublicKeyCredential,
    /// `getClientExtensionResults().prf.results.first`, base64url.
    prf_first: Option<Zeroizing<String>>,
}

async fn unlock_finish(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
    Json(body): Json<PrfFinish>,
) -> ApiResult<Json<Value>> {
    let Some(Ceremony::VaultUnlock { auth, device_id }) =
        state.passkeys.take_ceremony(&body.ceremony_id)
    else {
        return Err(unknown_ceremony());
    };
    if device_id != device.device_id {
        return Err(other_device());
    }
    let result = verify(&state, &body.credential, &auth).await?;
    let prf = prf_output(body.prf_first)?;
    let credential_id = B64.encode(result.cred_id().as_slice());
    state
        .vault
        .unlock_with_passkey(&credential_id, &prf)
        .map_err(vault_error)?;
    let passkey_id = state
        .passkeys
        .passkey_by_credential_id(result.cred_id().as_slice())
        .await?
        .map(|p| p.id);
    after_unlock(
        &state,
        &device.device_id,
        json!({ "via": "passkey", "passkeyId": passkey_id }),
    )
    .await
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

// ---- wrappers ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct EnrollStart {
    passkey_id: String,
}

/// Starts an assertion from one registered passkey, with a new PRF salt. Its
/// PRF output becomes that passkey's wrapper.
async fn enroll_start(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<EnrollStart>,
) -> ApiResult<Json<Value>> {
    if !state.vault.is_unlocked() {
        return Err(vault_error(VaultError::Locked));
    }
    let record = state
        .passkeys
        .passkeys()
        .await?
        .into_iter()
        .find(|p| p.id == body.passkey_id)
        .ok_or_else(ApiError::not_found)?;
    let credential_id = record.passkey.cred_id().to_vec();
    let credential_id_b64 = B64.encode(&credential_id);
    let has_wrapper = state.vault.wrappers().map_err(vault_error)?.iter().any(|w| {
        matches!(&w.kind, WrapperKind::PasskeyPrf { credential_id, .. } if *credential_id == credential_id_b64)
    });
    if has_wrapper {
        return Err(vault_error(VaultError::DuplicateWrapper(credential_id_b64)));
    }
    let mut salt = [0u8; 32];
    rand::rng().fill_bytes(&mut salt);
    let prf_salt = B64.encode(salt);
    let (options, auth) = state
        .passkeys
        .webauthn()
        .start_passkey_authentication(std::slice::from_ref(&record.passkey))
        .map_err(ApiError::internal)?;
    let options = with_prf(&options, &[(credential_id_b64, prf_salt.clone())]);
    start_ceremony(
        &state,
        Ceremony::VaultEnroll {
            auth,
            device_id: device.device_id,
            credential_id,
            prf_salt,
            label: record.label,
        },
        options,
    )
}

async fn enroll_finish(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<PrfFinish>,
) -> ApiResult<Json<Value>> {
    let Some(Ceremony::VaultEnroll {
        auth,
        device_id,
        credential_id,
        prf_salt,
        label,
    }) = state.passkeys.take_ceremony(&body.ceremony_id)
    else {
        return Err(unknown_ceremony());
    };
    if device_id != device.device_id {
        return Err(other_device());
    }
    let result = verify(&state, &body.credential, &auth).await?;
    if result.cred_id().as_slice() != credential_id.as_slice() {
        return Err(ApiError::bad_request(
            "that assertion came from another passkey",
        ));
    }
    let prf = prf_output(body.prf_first)?;
    let credential_id_b64 = B64.encode(&credential_id);
    state
        .vault
        .add_passkey_wrapper(&credential_id_b64, &prf_salt, &label, &prf)
        .map_err(vault_error)?;
    Ok(Json(
        json!({ "wrapperId": passkey_wrapper_id(&credential_id_b64) }),
    ))
}

async fn remove_wrapper(
    State(state): State<AppState>,
    _: Fresh<Admin>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    match state.vault.remove_wrapper(&id) {
        Ok(()) => Ok(StatusCode::NO_CONTENT),
        Err(VaultError::NoMatchingWrapper) => Err(ApiError::not_found()),
        Err(e) => Err(vault_error(e)),
    }
}
