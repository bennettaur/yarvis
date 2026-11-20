//! The Yarvis server. See `docs/client-server.md` for the design.

pub mod agent_policy;
pub mod auth;
pub mod config;
pub mod core_api;
pub mod custom_providers;
pub mod embeddings_secrets;
pub mod error;
pub mod events;
pub mod harness;
pub mod http_guard;
pub mod mcp;
pub mod secret_blob;
pub mod secret_store;
pub mod settings;
pub mod sidecar;
pub mod sidecar_proxy;
pub mod store;
pub mod web;

use std::sync::Arc;

use axum::Router;
use axum::extract::FromRef;
use axum::routing::{any, get, post};

use crate::auth::{Auth, Authed, DeviceContext, Read};
use crate::config::Config;
use crate::events::EventLog;
use crate::secret_blob::SecretBlob;
use crate::settings::SettingsStore;
use crate::sidecar::Sidecar;
use crate::store::Store;

/// State every route can reach. Modules that need their own state add a
/// field here and build it in [`AppState::new`].
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub auth: Auth,
    pub events: EventLog,
    pub settings: SettingsStore,
    pub secrets: SecretBlob,
    pub sidecar: Sidecar,
}

impl AppState {
    pub fn new(config: Config, store: Store) -> Self {
        // No I/O: settings are read on use, and the sidecar only starts when
        // `main` runs its supervisor.
        let settings = SettingsStore::new(SettingsStore::default_path());
        let secrets = SecretBlob::from_config(config.secrets.backend, settings.clone());
        let sidecar = Sidecar::new(&config.server.data_dir)
            .expect("couldn't pick a loopback port for the sidecar");
        Self {
            settings,
            secrets,
            sidecar,
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
        .route("/api/sidecar/{*path}", any(sidecar_proxy::proxy))
        .route("/api/core/{command}", post(core_api::command))
        .merge(web::fallback(state.config.server.web_dir.as_deref()))
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
