use std::path::PathBuf;

use tracing_subscriber::EnvFilter;
use yarvis_server::config::Config;
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
    tracing::info!("listening on http://{bind}");
    axum::serve(listener, app(AppState::new(config, store)))
        .with_graceful_shutdown(async {
            let _ = tokio::signal::ctrl_c().await;
        })
        .await
        .expect("server error");
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
