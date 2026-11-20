//! The Yarvis server. See `docs/client-server.md` for the design.

pub mod approvals;
pub mod auth;
pub mod config;
pub mod devices;
pub mod error;
pub mod events;
pub mod http_guard;
pub mod rate_limit;
pub mod secret_store;
pub mod store;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::FromRef;
use axum::routing::get;

use crate::approvals::Approvals;
use crate::auth::passkeys::PasskeyAuth;
use crate::auth::{Auth, Authed, DeviceContext, Read};
use crate::config::Config;
use crate::events::EventLog;
use crate::rate_limit::RateLimiter;
use crate::store::Store;

/// Enough for a person retrying a passkey prompt, few enough that a script
/// can't fill the ceremony map.
const AUTH_REQUESTS_PER_MINUTE: u32 = 30;

/// State every route can reach. Modules that need their own state add a
/// field here and build it in [`AppState::new`].
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub auth: Auth,
    pub events: EventLog,
    pub passkeys: PasskeyAuth,
    pub approvals: Approvals,
    /// Shared by the routes that need no token.
    pub auth_limiter: RateLimiter,
}

impl AppState {
    /// Panics on an `[auth]` config webauthn-rs refuses; `main` checks it
    /// first with [`PasskeyAuth::new`] to exit with a message instead.
    pub fn new(config: Config, store: Store) -> Self {
        let events = EventLog::new(store.clone());
        Self {
            passkeys: PasskeyAuth::new(&config.auth, store.clone())
                .unwrap_or_else(|e| panic!("invalid [auth] config: {e}")),
            approvals: Approvals::new(store.clone(), events.clone()),
            auth_limiter: RateLimiter::new(AUTH_REQUESTS_PER_MINUTE, Duration::from_secs(60)),
            config: Arc::new(config),
            auth: Auth::new(store.clone()),
            events,
            store,
        }
    }
}

impl FromRef<AppState> for Auth {
    fn from_ref(state: &AppState) -> Self {
        state.auth.clone()
    }
}

/// The whole app. Each module contributes its routes here.
pub fn app(state: AppState) -> Router {
    Router::new()
        .route("/api/health", get(health))
        .route("/api/devices/me", get(me))
        .route("/api/events", get(events::ws))
        .merge(auth::routes::router(&state))
        .merge(devices::router())
        .merge(approvals::router())
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            http_guard::guard,
        ))
        .with_state(state)
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "status": "ok", "service": "yarvis-server" }))
}

async fn me(Authed { device, .. }: Authed<Read>) -> axum::Json<DeviceContext> {
    axum::Json(device)
}
