//! The Yarvis server. See `docs/client-server.md` for the design.

pub mod agent_policy;
pub mod approvals;
pub mod auth;
pub mod config;
pub mod control;
pub mod core_api;
pub mod custom_providers;
pub mod database_url;
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
use axum::extract::{FromRef, State};
use axum::routing::{any, get, post};

use crate::approvals::Approvals;
use crate::auth::account::Account;
use crate::auth::{Auth, Authed, DeviceContext, Read};
use crate::config::Config;
use crate::events::EventLog;
use crate::pty::{PtyManager, PtyOptions};
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
    /// The database URL and where it came from, for Settings to show. `main`
    /// fills it in; `AppState::new` only gets the store.
    pub database: Option<database_url::DatabaseUrl>,
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
            PtyOptions {
                path: config.server.spawn_path().map(str::to_string),
                ..PtyOptions::default()
            },
        );
        pty.set_server_ssh_agent(ssh_agent::configured_socket(&config));
        // The sidecar's port and tokens are fixed for the server's life, so
        // every session can be given them from the start.
        pty.set_sidecar_env(Some(sidecar.session_env()));
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
            database: None,
        }
    }
}

/// Gives the sidecar what only a running server has: the database URL it
/// connected with (`DATABASE_URL`) and the control socket's path
/// (`YARVIS_CORE_SOCK`). Both are read at spawn, so this runs before the
/// sidecar's supervisor starts. Without the socket the sidecar can't start or
/// message agent sessions, fire alarms or save MCP and GitHub tokens.
pub async fn hand_off_to_sidecar(state: &mut AppState, database: database_url::DatabaseUrl) {
    state.sidecar.set_env("DATABASE_URL", &database.url);
    state.database = Some(database);
    #[cfg(unix)]
    match control::start(state.clone()).await {
        Ok(path) => state
            .sidecar
            .set_env("YARVIS_CORE_SOCK", &path.to_string_lossy()),
        Err(e) => tracing::error!("the control socket isn't available: {e}"),
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
        .route("/api/devices/me", get(me).delete(devices::revoke_self))
        .route("/api/events", get(events::ws))
        .merge(auth::routes::router(&state))
        .merge(devices::router())
        .merge(approvals::router())
        .merge(vault::routes::router(&state))
        .merge(ssh_agent::router(&state))
        .route("/api/pty", get(pty::list_route))
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

/// 503 until the database has been reached and migrated once, so a client
/// waiting for the server to start waits for that too. A later outage shows
/// as 503s on the routes that need the database, not here.
async fn health(
    State(state): State<AppState>,
) -> (axum::http::StatusCode, axum::Json<serde_json::Value>) {
    let (status, label, database) = if state.store.is_ready() {
        (axum::http::StatusCode::OK, "ok", "ok")
    } else {
        (
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            "starting",
            "unavailable",
        )
    };
    (
        status,
        axum::Json(serde_json::json!({
            "status": label,
            "service": "yarvis-server",
            "database": database,
        })),
    )
}

async fn me(Authed { device, .. }: Authed<Read>) -> axum::Json<DeviceContext> {
    axum::Json(device)
}
