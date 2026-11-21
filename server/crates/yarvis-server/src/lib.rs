//! The Yarvis server. See `docs/client-server.md` for the design.

pub mod agent_policy;
pub mod approvals;
pub mod auth;
pub mod config;
pub mod control;
pub mod core_api;
pub mod custom_providers;
pub mod devices;
pub mod embeddings_secrets;
pub mod error;
pub mod events;
pub mod harness;
pub mod http_guard;
pub mod mcp;
pub mod pty;
pub mod rate_limit;
pub mod secret_blob;
pub mod secret_store;
pub mod settings;
pub mod sidecar;
pub mod sidecar_proxy;
pub mod ssh_agent;
pub mod store;
pub mod vault;
pub mod web;

use std::sync::Arc;
use std::time::Duration;

use axum::Router;
use axum::extract::FromRef;
use axum::routing::{any, get, post};

use crate::approvals::Approvals;
use crate::auth::account::Account;
use crate::auth::{Auth, Authed, DeviceContext, Read};
use crate::config::Config;
use crate::events::EventLog;
use crate::pty::{PtyManager, PtyOptions, SidecarSessionEnv};
use crate::rate_limit::RateLimiter;
use crate::secret_blob::SecretBlob;
use crate::settings::SettingsStore;
use crate::sidecar::Sidecar;
use crate::ssh_agent::SshAgent;
use crate::store::Store;
use crate::vault::Vault;

/// Enough for a person retyping a passphrase or code, few enough that a script
/// gets nowhere before the account lockout.
const AUTH_REQUESTS_PER_MINUTE: u32 = 30;

/// State every route can reach. Modules that need their own state add a
/// field here and build it in [`AppState::new`].
#[derive(Clone)]
pub struct AppState {
    pub config: Arc<Config>,
    pub store: Store,
    pub auth: Auth,
    pub events: EventLog,
    pub account: Account,
    pub approvals: Approvals,
    /// Shared by the routes that need no token.
    pub auth_limiter: RateLimiter,
    /// Locked until its passphrase or the recovery key opens it. Only used when
    /// `secrets.backend = "vault"`.
    pub vault: Vault,
    /// Runs only while the vault is unlocked, and never when
    /// `ssh_agent.enabled` is off.
    pub ssh_agent: SshAgent,
    pub settings: SettingsStore,
    pub secrets: SecretBlob,
    pub sidecar: Sidecar,
    pub pty: PtyManager,
}

impl AppState {
    pub fn new(config: Config, store: Store) -> Self {
        let events = EventLog::new(store.clone());
        // No I/O: settings are read on use, and the sidecar only starts when
        // `main` runs its supervisor.
        let settings = SettingsStore::new(SettingsStore::default_path());
        let vault = Vault::new(&config.server.data_dir);
        let secrets = SecretBlob::from_config(config.secrets.backend, settings.clone(), &vault);
        let sidecar = Sidecar::new(&config.server.data_dir)
            .expect("couldn't pick a loopback port for the sidecar");
        let pty = PtyManager::new(
            settings.clone(),
            secrets.clone(),
            events.clone(),
            config.ssh_agent.clone(),
            PtyOptions::default(),
        );
        pty.set_server_ssh_agent(ssh_agent::configured_socket(&config));
        // The sidecar's port and tokens are fixed for the server's life, so
        // every session can be given them from the start.
        pty.set_sidecar_env(Some(SidecarSessionEnv {
            port: sidecar.endpoint().port,
            attention_token: sidecar.attention_token().to_string(),
            signing_key: sidecar.endpoint().token.clone(),
            mcp_token: Some(sidecar.mcp_token().to_string()),
        }));
        Self {
            account: Account::new(store.clone()),
            approvals: Approvals::new(store.clone(), events.clone()),
            auth_limiter: RateLimiter::new(AUTH_REQUESTS_PER_MINUTE, Duration::from_secs(60)),
            vault,
            ssh_agent: SshAgent::default(),
            settings,
            secrets,
            sidecar,
            pty,
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
        .merge(vault::routes::router(&state))
        .merge(ssh_agent::router(&state))
        .route("/api/pty/{id}", get(pty::ws::ws))
        .route(
            "/api/voice/turn-detector/socket",
            get(sidecar_proxy::turn_detector_socket),
        )
        .merge(sidecar_proxy::oauth_callback_router())
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
