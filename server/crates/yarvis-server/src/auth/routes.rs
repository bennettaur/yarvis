//! `/api/auth/*` and `/api/account/*`: setup with the one-time code, sign-in
//! with the passphrase and a TOTP or backup code, the freshness check, and
//! managing the account.

use axum::extract::State;
use axum::http::header::USER_AGENT;
use axum::http::{HeaderMap, StatusCode};
use axum::routing::{get, post};
use axum::{Json, Router, middleware};
use serde::{Deserialize, Serialize};
use serde_json::json;
use zeroize::Zeroizing;

use super::account::{AccountError, Enrollment, SecondFactor, SetupError, check_passphrase_shape};
use super::fresh::Fresh;
use super::setup_code::CodeError;
use super::{Admin, Authed, DeviceContext, Scope, create_device};
use crate::AppState;
use crate::config::SecretBackendKind;
use crate::devices::device_name;
use crate::error::{ApiError, ApiResult};
use crate::rate_limit;
use crate::store::now_ms;

/// The kind of device a sign-in makes. Only these can be fresh.
pub const LOGIN_DEVICE: &str = "login";

pub fn router(state: &AppState) -> Router<AppState> {
    // These need no token and each spends a setup code guess or a sign-in
    // attempt, so they are rate-limited per address. Status is left out so a
    // client polling it can't use up the owner's budget.
    let open = Router::new()
        .route("/api/auth/setup/start", post(setup_start))
        .route("/api/auth/setup/finish", post(setup_finish))
        .route("/api/auth/login", post(login))
        .route_layer(middleware::from_fn_with_state(
            state.auth_limiter.clone(),
            rate_limit::limit,
        ));
    Router::new()
        .route("/api/auth/status", get(status))
        .route("/api/auth/reverify", post(reverify))
        .route("/api/account", get(account))
        .route("/api/account/passphrase", post(change_passphrase))
        .route("/api/account/totp/start", post(reenroll_start))
        .route("/api/account/totp/finish", post(reenroll_finish))
        .route("/api/account/backup-codes", post(regenerate_backup_codes))
        .route("/api/account/sign-out-others", post(sign_out_others))
        .merge(open)
}

impl From<AccountError> for ApiError {
    fn from(e: AccountError) -> Self {
        ApiError::internal(e)
    }
}

/// A device's token, shown once. Only its hash is kept.
#[derive(Serialize)]
pub struct SignedIn {
    pub token: String,
    pub device: DeviceContext,
}

/// One message for every wrong passphrase, code or backup code, so a caller
/// can't learn which part was right.
fn wrong_credentials() -> ApiError {
    ApiError::new(StatusCode::UNAUTHORIZED, "wrong passphrase or code")
}

/// 403, not 401: on routes a signed-in device calls, a 401 means the token is
/// no good, and clients sign out on it. A mistyped code isn't that.
fn wrong_code() -> ApiError {
    ApiError::new(StatusCode::FORBIDDEN, "wrong code")
        .with_detail("enter the code your authenticator app shows now")
}

fn locked(left: std::time::Duration) -> ApiError {
    let minutes = left.as_secs().div_ceil(60).max(1);
    ApiError::new(StatusCode::TOO_MANY_REQUESTS, "too many failed sign-ins")
        .with_detail(format!("try again in {minutes} minutes"))
}

fn setup_done() -> ApiError {
    ApiError::conflict("setup is done").with_detail("sign in instead")
}

fn bad_passphrase(reason: String) -> ApiError {
    ApiError::bad_request(reason)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct EnrollmentBody {
    enrollment_id: String,
    /// The secret in base32, for typing into an app by hand.
    secret: String,
    otpauth_uri: String,
    /// The URI as a QR code, an SVG document.
    qr_svg: String,
}

impl From<Enrollment> for EnrollmentBody {
    fn from(e: Enrollment) -> Self {
        Self {
            enrollment_id: e.id,
            secret: e.secret_base32,
            otpauth_uri: e.otpauth_uri,
            qr_svg: e.qr_svg,
        }
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Status {
    setup_required: bool,
    vault: &'static str,
}

async fn status(State(state): State<AppState>) -> ApiResult<Json<Status>> {
    let vault = match state.config.secrets.backend {
        Some(SecretBackendKind::Vault) => state.vault.state().map_err(ApiError::internal)?.as_str(),
        Some(SecretBackendKind::Keychain | SecretBackendKind::OnePassword) | None => "absent",
    };
    Ok(Json(Status {
        setup_required: state.account.setup_required().await?,
        vault,
    }))
}

// ---- setup ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupStart {
    code: String,
    passphrase: Zeroizing<String>,
    device_name: String,
}

async fn setup_start(
    State(state): State<AppState>,
    Json(body): Json<SetupStart>,
) -> ApiResult<Json<EnrollmentBody>> {
    let device_name = device_name(&body.device_name)?;
    if !state.account.setup_required().await? {
        return Err(setup_done());
    }
    check_passphrase_shape(&body.passphrase).map_err(bad_passphrase)?;
    let wrong = || ApiError::new(StatusCode::UNAUTHORIZED, "wrong setup code");
    match state
        .account
        .start_setup(&body.code, body.passphrase, device_name)
        .await?
    {
        Ok(enrollment) => Ok(Json(enrollment.into())),
        Err(CodeError::NoCode) => Err(ApiError::new(
            StatusCode::UNAUTHORIZED,
            "no setup code is outstanding",
        )
        .with_detail("restart the server, or run `yarvis-server auth reset`, to get a new one")),
        Err(CodeError::Wrong { attempts_left: 0 }) => {
            Err(wrong().with_detail("that was the last try; restart the server to get a new code"))
        }
        Err(CodeError::Wrong { attempts_left }) => {
            Err(wrong().with_detail(format!("{attempts_left} tries left")))
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SetupFinish {
    enrollment_id: String,
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SetUpBody {
    token: String,
    device: DeviceContext,
    /// Shown once; only hashes are kept.
    backup_codes: Vec<String>,
}

async fn setup_finish(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<SetupFinish>,
) -> ApiResult<Json<SetUpBody>> {
    let set_up = match state
        .account
        .finish_setup(&body.enrollment_id, &body.code)
        .await?
    {
        Ok(set_up) => set_up,
        Err(SetupError::WrongCode) => return Err(wrong_code()),
        Err(SetupError::UnknownEnrollment) => {
            return Err(
                ApiError::bad_request("unknown or expired setup").with_detail("start again")
            );
        }
        Err(SetupError::CodeGone) => {
            return Err(ApiError::new(
                StatusCode::UNAUTHORIZED,
                "the setup code was already used",
            ));
        }
        Err(SetupError::Done) => return Err(setup_done()),
    };
    state
        .events
        .append(None, "account.created", json!({}))
        .await?;
    let signed_in = sign_in(&state, &set_up.device_name, &headers).await?;
    Ok(Json(SetUpBody {
        token: signed_in.token,
        device: signed_in.device,
        backup_codes: set_up.backup_codes,
    }))
}

// ---- login ----

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Login {
    passphrase: Zeroizing<String>,
    code: Option<String>,
    backup_code: Option<String>,
    device_name: String,
}

/// Every sign-in makes a new device. A client that is still signed in has no
/// reason to sign in again, and one that lost its token is, as far as the
/// server can tell, a new device.
async fn login(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<Login>,
) -> ApiResult<Json<SignedIn>> {
    let device_name = device_name(&body.device_name)?;
    if state.account.setup_required().await? {
        return Err(ApiError::conflict("this server isn't set up yet")
            .with_detail("enter the setup code it printed"));
    }
    if let Some(left) = state.account.locked_for() {
        return Err(locked(left));
    }
    let factor = match (&body.code, &body.backup_code) {
        (Some(code), None) => SecondFactor::Totp(code),
        (None, Some(code)) => SecondFactor::Backup(code),
        _ => return Err(ApiError::bad_request("send a code or a backup code")),
    };
    if !state.account.check_login(body.passphrase, factor).await? {
        return Err(wrong_credentials());
    }
    if body.backup_code.is_some() {
        let left = state.account.backup_codes_left().await?;
        state
            .events
            .append(None, "account.backup_code_used", json!({ "left": left }))
            .await?;
    }
    Ok(Json(sign_in(&state, &device_name, &headers).await?))
}

/// Creates a signed-in device: every scope, and fresh.
async fn sign_in(state: &AppState, name: &str, headers: &HeaderMap) -> ApiResult<SignedIn> {
    let (device_id, token) =
        create_device(&state.store, name, LOGIN_DEVICE, &Scope::ALL, None).await?;
    let user_agent: Option<String> = headers
        .get(USER_AGENT)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.chars().take(200).collect());
    let verified_at = now_ms();
    let row_id = device_id.clone();
    state
        .store
        .call(move |conn| {
            conn.execute(
                "UPDATE devices SET user_agent = ?1, verified_at = ?2 WHERE id = ?3",
                rusqlite::params![user_agent, verified_at, row_id],
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
                "kind": LOGIN_DEVICE,
                "scopes": Scope::ALL,
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

#[derive(Deserialize)]
struct Reverify {
    code: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Verified {
    verified_at: i64,
}

async fn device_kind(state: &AppState, device_id: &str) -> ApiResult<String> {
    let id = device_id.to_string();
    Ok(state
        .store
        .call(move |conn| {
            conn.query_row("SELECT kind FROM devices WHERE id = ?1", [id], |row| {
                row.get(0)
            })
        })
        .await?)
}

/// A code from the authenticator app makes this device fresh.
async fn reverify(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Admin>,
    Json(body): Json<Reverify>,
) -> ApiResult<Json<Verified>> {
    // A token wasn't made by a sign-in. If it could reverify, a stolen admin
    // token plus one shoulder-surfed code would make it fresh.
    if device_kind(&state, &device.device_id).await? != LOGIN_DEVICE {
        return Err(ApiError::forbidden(
            "only a device that signed in with the passphrase can confirm with a code",
        ));
    }
    if let Some(left) = state.account.locked_for() {
        return Err(locked(left));
    }
    if !state.account.check_code(&body.code).await? {
        return Err(wrong_code());
    }
    let verified_at = now_ms();
    let device_id = device.device_id;
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

// ---- the account ----

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct AccountBody {
    backup_codes_left: i64,
}

async fn account(State(state): State<AppState>, _: Authed<Admin>) -> ApiResult<Json<AccountBody>> {
    Ok(Json(AccountBody {
        backup_codes_left: state.account.backup_codes_left().await?,
    }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SignedOut {
    revoked_devices: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ChangePassphrase {
    current_passphrase: Zeroizing<String>,
    new_passphrase: Zeroizing<String>,
    #[serde(default)]
    sign_out_other_devices: bool,
}

async fn change_passphrase(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<ChangePassphrase>,
) -> ApiResult<Json<SignedOut>> {
    check_passphrase_shape(&body.new_passphrase).map_err(bad_passphrase)?;
    if let Some(left) = state.account.locked_for() {
        return Err(locked(left));
    }
    if !state
        .account
        .check_current_passphrase(body.current_passphrase)
        .await?
    {
        return Err(ApiError::new(
            StatusCode::FORBIDDEN,
            "that isn't the current passphrase",
        ));
    }
    state.account.set_passphrase(body.new_passphrase).await?;
    state
        .events
        .append(
            Some(&device.device_id),
            "account.changed",
            json!({ "what": "passphrase" }),
        )
        .await?;
    let revoked_devices = if body.sign_out_other_devices {
        revoke_others(&state, &device.device_id).await?
    } else {
        Vec::new()
    };
    Ok(Json(SignedOut { revoked_devices }))
}

async fn reenroll_start(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
) -> ApiResult<Json<EnrollmentBody>> {
    Ok(Json(state.account.start_reenroll(&device.device_id).into()))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReenrollFinish {
    enrollment_id: String,
    code: String,
    #[serde(default)]
    sign_out_other_devices: bool,
}

async fn reenroll_finish(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
    Json(body): Json<ReenrollFinish>,
) -> ApiResult<Json<SignedOut>> {
    match state
        .account
        .finish_reenroll(&body.enrollment_id, &device.device_id, &body.code)
        .await?
    {
        Ok(()) => {}
        Err(SetupError::WrongCode) => return Err(wrong_code()),
        Err(_) => {
            return Err(
                ApiError::bad_request("unknown or expired enrollment").with_detail("start again")
            );
        }
    }
    state
        .events
        .append(
            Some(&device.device_id),
            "account.changed",
            json!({ "what": "totp" }),
        )
        .await?;
    let revoked_devices = if body.sign_out_other_devices {
        revoke_others(&state, &device.device_id).await?
    } else {
        Vec::new()
    };
    Ok(Json(SignedOut { revoked_devices }))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BackupCodes {
    backup_codes: Vec<String>,
}

async fn regenerate_backup_codes(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
) -> ApiResult<Json<BackupCodes>> {
    let backup_codes = state.account.regenerate_backup_codes().await?;
    state
        .events
        .append(
            Some(&device.device_id),
            "account.changed",
            json!({ "what": "backupCodes" }),
        )
        .await?;
    Ok(Json(BackupCodes { backup_codes }))
}

async fn sign_out_others(
    State(state): State<AppState>,
    Fresh { device, .. }: Fresh<Admin>,
) -> ApiResult<Json<SignedOut>> {
    Ok(Json(SignedOut {
        revoked_devices: revoke_others(&state, &device.device_id).await?,
    }))
}

/// Revokes every live device but `keep`, tokens included, and closes their
/// connections.
async fn revoke_others(state: &AppState, keep: &str) -> ApiResult<Vec<String>> {
    let keep_id = keep.to_string();
    let revoked: Vec<String> = state
        .store
        .call(move |conn| {
            let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
            let ids = {
                let mut stmt =
                    tx.prepare("SELECT id FROM devices WHERE id != ?1 AND revoked_at IS NULL")?;
                stmt.query_map([&keep_id], |row| row.get(0))?
                    .collect::<rusqlite::Result<Vec<String>>>()?
            };
            tx.execute(
                "UPDATE devices SET revoked_at = ?1 WHERE id != ?2 AND revoked_at IS NULL",
                rusqlite::params![now_ms(), keep_id],
            )?;
            tx.commit()?;
            Ok(ids)
        })
        .await?;
    for id in &revoked {
        state.auth.announce_revocation(id);
        state
            .events
            .append(Some(keep), "device.revoked", json!({ "deviceId": id }))
            .await?;
    }
    Ok(revoked)
}
