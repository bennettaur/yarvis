//! The Yarvis server. See `docs/client-server.md` for the design.

pub mod auth;
pub mod config;
pub mod error;
pub mod events;
pub mod secret_store;
pub mod store;

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRef;
use axum::routing::get;

use crate::auth::{Auth, Authed, DeviceContext, Read};
use crate::config::Config;
use crate::events::EventLog;
use crate::store::Store;

/// State every route can reach. Modules that need their own state add a
/// field here and build it in [`AppState::new`].
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub auth: Auth,
    pub events: EventLog,
}

impl AppState {
    pub fn new(config: Config, store: Store) -> Self {
        Self {
            config: Arc::new(config),
            auth: Auth::new(store.clone()),
            events: EventLog::new(store.clone()),
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
        .with_state(state)
}

async fn health() -> axum::Json<serde_json::Value> {
    axum::Json(serde_json::json!({ "status": "ok", "service": "yarvis-server" }))
}

async fn me(Authed { device, .. }: Authed<Read>) -> axum::Json<DeviceContext> {
    axum::Json(device)
}
