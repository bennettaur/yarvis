//! `/api/auth/*` and `/api/passkeys/*`: setup with the one-time code, passkey
//! sign-in, the freshness check, and adding more passkeys.
//!
//! Every WebAuthn exchange is two requests. `start` stores the ceremony and
//! returns `{ ceremonyId, options }`; `finish` names the ceremony and carries
//! the authenticator's answer. A ceremony can be finished once.

use axum::extract::State;
use axum::http::header::USER_AGENT;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use serde::{Deserialize, Serialize};
use serde_json::json;
use webauthn_rs::prelude::{
    PasskeyAuthentication, PublicKeyCredential, RegisterPublicKeyCredential, WebauthnError,
};

use super::fresh::Fresh;
use super::passkeys::Ceremony;
use super::setup_code::CodeError;
use super::{Admin, Authed, DeviceContext, Scope, create_device};
use crate::AppState;
use crate::config::SecretBackendKind;
use crate::devices::device_name;
use crate::error::{ApiError, ApiResult};
use crate::rate_limit;
use crate::store::now_ms;

pub fn router(state: &AppState) -> Router<AppState> {
    // Only these need no token, so only these are rate-limited per address.
    let open = Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/setup/start", post(setup_start))
        .route("/api/auth/setup/finish", post(setup_finish))
        .route("/api/auth/login/start", post(login_start))
        .route("/api/auth/login/finish", post(login_finish))
        .route_layer(middleware::from_fn_with_state(
            state.auth_limiter.clone(),
            rate_limit::limit,
        ));
    Router::new()
        .route("/api/auth/reverify/start", post(reverify_start))
        .route("/api/auth/reverify/finish", post(reverify_finish))
        .route("/api/passkeys/register/start", post(register_start))
        .route("/api/passkeys/register/finish", post(register_finish))
        .merge(open)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Started<T: Serialize> {
    ceremony_id: String,
    options: T,
}

/// A device's token, shown once. Only its hash is kept.
#[derive(Serialize)]
pub struct SignedIn {
    pub token: String,
    pub device: DeviceContext,
}

fn start_ceremony<T: Serialize>(
    state: &AppState,
    ceremony: Ceremony,
    options: T,
) -> ApiResult<Json<Started<T>>> {
    let ceremony_id = state.passkeys.start_ceremony(ceremony).ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "too many sign-ins in progress",
        )
        .with_detail("try again in a few minutes")
    })?;
    Ok(Json(Started {
        ceremony_id,
        options,
    }))
}

fn passkey_check_failed(e: WebauthnError) -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "passkey check failed").with_detail(e.to_string())
}

fn unknown_ceremony() -> ApiError {
    ApiError::bad_request("unknown or expired ceremony").with_detail("start again")
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    setup_required: bool,
    rp_id: String,
    vault: &'static str,
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<Status>> {
    // Nothing in the server can unlock a vault yet, so a vault stays locked.
    let vault = match state.config.secrets.backend {
        SecretBackendKind::Vault => "locked",
        SecretBackendKind::Keychain | SecretBackendKind::OnePassword => "absent",
    };
    Ok(Json(Status {
        setup_required: state.passkeys.setup_required().await?,
        rp_id: state.passkeys.rp_id().to_string(),
        vault,
    }))
}

// ---- setup ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupStart {
    code: String,
    device_name: String,
}

async fn setup_start(
    State(state): State<AppState>,
    Json(body): Json<SetupStart>,
) -> ApiResult<Json<Started<impl Serialize>>> {
    let device_name = device_name(&body.device_name)?;
    let wrong_code = || ApiError::new(StatusCode::UNAUTHORIZED, "wrong setup code");
    let code = state
        .passkeys
        .check_setup_code(&body.code)
        .map_err(|e| match e {
            CodeError::NoCode => {
                ApiError::new(StatusCode::UNAUTHORIZED, "no setup code is outstanding")
                    .with_detail("restart the server to get a new one")
            }
            CodeError::Wrong { attempts_left: 0 } => wrong_code()
                .with_detail("that was the last try; restart the server to get a new code"),
            CodeError::Wrong { attempts_left } => {
                wrong_code().with_detail(format!("{attempts_left} tries left"))
            }
        })?;
    let (options, reg) = state.passkeys.start_registration().await?;
    start_ceremony(
        &state,
        Ceremony::Setup {
            reg,
            code,
            device_name,
        },
        options,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RegisterFinish {
    ceremony_id: String,
    credential: RegisterPublicKeyCredential,
}

async fn setup_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RegisterFinish>,
) -> ApiResult<Json<SignedIn>> {
    let Some(Ceremony::Setup {
        reg,
        code,
        device_name,
    }) = state.passkeys.take_ceremony(&body.ceremony_id)
    else {
        return Err(unknown_ceremony());
    };
    let passkey = state
        .passkeys
        .webauthn()
        .finish_passkey_registration(&body.credential, &reg)
        .map_err(passkey_check_failed)?;
    // Only a verified registration uses the code, so a cancelled prompt
    // doesn't cost the owner their code. A second ceremony racing on the same
    // code finds it gone here.
    if !state.passkeys.consume_setup_code(&code) {
        return Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "the setup code was already used",
        ));
    }
    let passkey_id = state.passkeys.add_passkey(&device_name, passkey).await?;
    state
        .events
        .append(
            None,
            "passkey.added",
            json!({ "passkeyId": passkey_id, "via": "setup" }),
        )
        .await?;
    Ok(Json(
        sign_in(&state, &device_name, &passkey_id, &headers).await?,
    ))
}

// ---- login ----

async fn login_start(State(state): State<AppState>) -> ApiResult<Json<Started<impl Serialize>>> {
    let (options, auth) = state.passkeys.start_assertion().await?;
    start_ceremony(&state, Ceremony::Login { auth }, options)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LoginFinish {
    ceremony_id: String,
    credential: PublicKeyCredential,
    device_name: String,
}

/// Every sign-in makes a new device. A client that is still signed in has no
/// reason to sign in again, and one that lost its token is, as far as the
/// server can tell, a new device.
async fn login_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<LoginFinish>,
) -> ApiResult<Json<SignedIn>> {
    let device_name = device_name(&body.device_name)?;
    let Some(Ceremony::Login { auth }) = state.passkeys.take_ceremony(&body.ceremony_id) else {
        return Err(unknown_ceremony());
    };
    let passkey_id = finish_assertion(&state, &body.credential, &auth).await?;
    Ok(Json(
        sign_in(&state, &device_name, &passkey_id, &headers).await?,
    ))
}

/// Verifies an assertion and stores the passkey's new sign count. Returns the
/// id of the passkey that signed.
async fn finish_assertion(
    state: &AppState,
    credential: &PublicKeyCredential,
    auth: &PasskeyAuthentication,
) -> ApiResult<String> {
    let result = state
        .passkeys
        .webauthn()
        .finish_passkey_authentication(credential, auth)
        .map_err(passkey_check_failed)?;
    state
        .passkeys
        .record_use(&result)
        .await?
        .ok_or_else(|| ApiError::new(StatusCode::UNAUTHORIZED, "that passkey was removed"))
}

/// Creates a device signed in with a passkey: every scope, and fresh.
async fn sign_in(
    state: &AppState,
    name: &str,
    passkey_id: &str,
    headers: &HeaderMap,
) -> ApiResult<SignedIn> {
    let (device_id, token) =
        create_device(&state.store, name, "passkey", &Scope::ALL, None).await?;
    let user_agent: Option<String> = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(200).collect());
    let verified_at = now_ms();
    let (row_id, row_passkey_id) = (device_id.clone(), passkey_id.to_string());
    state
        .store
        .call(move |conn| {
            conn.execute(
                "UPDATE devices SET passkey_id = ?1, user_agent = ?2, verified_at = ?3
                 WHERE id = ?4",
                rusqlite::params![row_passkey_id, user_agent, verified_at, row_id],
            )
        })
        .await?;
    state
        .events
        .append(
            Some(&device_id),
            "device.created",
            json!({
                "deviceId": device_id,
                "name": name,
                "kind": "passkey",
                "scopes": Scope::ALL,
                "passkeyId": passkey_id,
            }),
        )
        .await?;
    Ok(SignedIn {
        token,
        device: DeviceContext {
            device_id,
            name: name.to_string(),
            scopes: Scope::ALL.to_vec(),
            verified_at: Some(verified_at),
        },
    })
}

// ---- reverify ----

async fn reverify_start(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
) -> ApiResult<Json<Started<impl Serialize>>> {
    let id = device.device_id.clone();
    let kind: String = state
        .store
        .call(move |conn| {
            conn.query_row("SELECT kind FROM devices WHERE id = ?1", [id], |row| {
                row.get(0)
            })
        })
        .await?;
    // A token has no passkey behind it. If it could reverify, a stolen admin
    // token could become fresh by getting the owner to approve one prompt.
    if kind != "passkey" {
        return Err(ApiError::forbidden(
            "only a device signed in with a passkey can confirm with one",
        ));
    }
    let (options, auth) = state.passkeys.start_assertion().await?;
    start_ceremony(
        &state,
        Ceremony::Reverify {
            auth,
            device_id: device.device_id,
        },
        options,
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AssertionFinish {
    ceremony_id: String,
    credential: PublicKeyCredential,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    verified_at: i64,
}

async fn reverify_finish(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
    Json(body): Json<AssertionFinish>,
) -> ApiResult<Json<Verified>> {
    let Some(Ceremony::Reverify { auth, device_id }) =
        state.passkeys.take_ceremony(&body.ceremony_id)
    else {
        return Err(unknown_ceremony());
    };
    if device_id != device.device_id {
        return Err(ApiError::forbidden(
            "this ceremony belongs to another device",
        ));
    }
    finish_assertion(&state, &body.credential, &auth).await?;
    let verified_at = now_ms();
    state
        .store
        .call(move |conn| {
            conn.execute(
                "UPDATE devices SET verified_at = ?1 WHERE id = ?2",
                rusqlite::params![verified_at, device_id],
            )
        })
        .await?;
    Ok(Json(Verified { verified_at }))
}

// ---- more passkeys ----

#[derive(Deserialize)]
struct RegisterStart {
    label: String,
}

/// Adds another passkey from a signed-in device, such as a security key as a
/// backup.
async fn register_start(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<RegisterStart>,
) -> ApiResult<Json<Started<impl Serialize>>> {
    let label = device_name(&body.label)?;
    let (options, reg) = state.passkeys.start_registration().await?;
    start_ceremony(
        &state,
        Ceremony::AddPasskey {
            reg,
            device_id: device.device_id,
            label,
        },
        options,
    )
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Added {
    passkey_id: String,
}

async fn register_finish(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<RegisterFinish>,
) -> ApiResult<Json<Added>> {
    let Some(Ceremony::AddPasskey {
        reg,
        device_id,
        label,
    }) = state.passkeys.take_ceremony(&body.ceremony_id)
    else {
        return Err(unknown_ceremony());
    };
    if device_id != device.device_id {
        return Err(ApiError::forbidden(
            "this ceremony belongs to another device",
        ));
    }
    let passkey = state
        .passkeys
        .webauthn()
        .finish_passkey_registration(&body.credential, &reg)
        .map_err(passkey_check_failed)?;
    let passkey_id = state.passkeys.add_passkey(&label, passkey).await?;
    state
        .events
        .append(
            Some(&device.device_id),
            "passkey.added",
            json!({ "passkeyId": passkey_id, "via": "signedInDevice" }),
        )
        .await?;
    Ok(Json(Added { passkey_id }))
}
