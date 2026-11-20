use std::future::IntoFuture;
use std::path::PathBuf;

use tracing_subscriber::EnvFilter;
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::secret_blob::Store as SecretStore;
use yarvis_server::sidecar::SupervisorDeps;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

const USAGE: &str = "usage: yarvis-server [--config PATH]";

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let config_path = match parse_args(std::env::args().skip(1)) {
        Ok(path) => path,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let config = Config::load(&config_path).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    if config.secrets.backend == SecretBackendKind::Vault {
        eprintln!(
            "the vault backend isn't built yet; set [secrets] backend to \"keychain\" or \"onepassword\" in {}",
            config_path.display()
        );
        std::process::exit(1);
    }
    let store = Store::open(&config.server.data_dir.join("server.db")).unwrap_or_else(|e| {
        eprintln!("{e}");
        std::process::exit(1);
    });
    let bind = config.server.bind;
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .unwrap_or_else(|e| {
            eprintln!("couldn't listen on {bind}: {e}");
            std::process::exit(1);
        });
    let state = AppState::new(config, store);
    start_core(&state).await;
    tracing::info!("listening on http://{bind}");
    let server = axum::serve(listener, app(state))
        .with_graceful_shutdown(shutdown_signal())
        .into_future();
    // Graceful shutdown waits for every connection, and event and PTY
    // WebSockets never end on their own, so give them a few seconds and go.
    tokio::select! {
        result = server => result.expect("server error"),
        _ = async {
            shutdown_signal().await;
            tokio::time::sleep(SHUTDOWN_GRACE).await;
        } => tracing::info!("open connections didn't close in time; exiting"),
    }
}

const SHUTDOWN_GRACE: std::time::Duration = std::time::Duration::from_secs(5);

/// Ctrl-C, or SIGTERM from launchd.
async fn shutdown_signal() {
    #[cfg(unix)]
    {
        let mut term = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("SIGTERM handler");
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    let _ = tokio::signal::ctrl_c().await;
}

fn parse_args(mut args: impl Iterator<Item = String>) -> Result<PathBuf, String> {
    let mut config = None;
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--config" => config = Some(args.next().ok_or("--config needs a path")?),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    Ok(config
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path))
}

fn default_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".yarvis").join("server.toml"))
        .unwrap_or_else(|| PathBuf::from("server.toml"))
}

/// Settings and secrets housekeeping, then the sidecar.
async fn start_core(state: &AppState) {
    state.settings.ensure_dir();
    // Both migrations move values a past desktop build wrote to the Keychain,
    // so they only run on a server that uses it.
    if state.config.secrets.backend == SecretBackendKind::Keychain {
        let (settings, secrets) = (state.settings.clone(), state.secrets.clone());
        let migrated = tokio::task::spawn_blocking(move || {
            let keychain = SecretStore::keychain();
            settings.migrate_keychain_settings(&secrets, &keychain);
            yarvis_server::embeddings_secrets::migrate_legacy_item(&secrets, &keychain);
        })
        .await;
        if let Err(e) = migrated {
            tracing::error!("the Keychain migrations panicked: {e}");
        }
    }
    if !state.config.sidecar.enabled {
        tracing::info!("sidecar.enabled is false; not starting the sidecar");
        return;
    }
    let deps = SupervisorDeps {
        config: state.config.clone(),
        settings: state.settings.clone(),
        secrets: state.secrets.clone(),
        events: state.events.clone(),
    };
    tokio::spawn(state.sidecar.clone().supervise(deps));
}
