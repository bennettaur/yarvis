use std::future::IntoFuture;
use std::net::SocketAddr;
use std::path::PathBuf;

use tracing_subscriber::EnvFilter;
use yarvis_server::auth::passkeys::PasskeyAuth;
use yarvis_server::config::Config;
use yarvis_server::devices::{add_token_device, parse_scope_list};
use yarvis_server::events::EventLog;
use yarvis_server::store::Store;
use yarvis_server::{AppState, app};

const USAGE: &str = "usage: yarvis-server [--config PATH]
       yarvis-server device add --name NAME --scopes read,chat,approve,admin [--config PATH]";

#[derive(Debug)]
enum Command {
    Serve,
    /// Pairs a client without a passkey. Only someone who can run commands on
    /// the server machine can do this, the same trust as reading the setup code.
    AddDevice {
        name: String,
        scopes: String,
    },
}

#[tokio::main]
async fn main() {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();

    let (command, config_path) = match parse_args(std::env::args().skip(1)) {
        Ok(parsed) => parsed,
        Err(message) => {
            eprintln!("{message}\n{USAGE}");
            std::process::exit(2);
        }
    };
    let config = Config::load(&config_path).unwrap_or_else(|e| fail(e));
    let store = Store::open(&config.server.data_dir.join("server.db")).unwrap_or_else(|e| fail(e));
    match command {
        Command::Serve => serve(config, store).await,
        Command::AddDevice { name, scopes } => add_device(store, &name, &scopes).await,
    }
}

async fn serve(config: Config, store: Store) {
    if let Err(e) = PasskeyAuth::new(&config.auth, store.clone()) {
        fail(e);
    }
    let bind = config.server.bind;
    let state = AppState::new(config, store);
    match state.approvals.deny_orphaned().await {
        Ok(0) => {}
        Ok(n) => tracing::info!("denied {n} approvals left pending by the last run"),
        Err(e) => fail(e),
    }
    // stdout, never the log: whoever holds this code can claim the server.
    match state.passkeys.issue_setup_code_if_needed().await {
        Ok(Some(code)) => println!("No passkey is registered yet. Setup code: {code}"),
        Ok(None) => {}
        Err(e) => fail(e),
    }
    let listener = tokio::net::TcpListener::bind(bind)
        .await
        .unwrap_or_else(|e| fail(format!("couldn't listen on {bind}: {e}")));
    tracing::info!("listening on http://{bind}");
    // The peer address feeds the per-IP limit on the sign-in routes.
    let server = axum::serve(
        listener,
        app(state).into_make_service_with_connect_info::<SocketAddr>(),
    )
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

async fn add_device(store: Store, name: &str, scopes: &str) {
    let name = yarvis_server::devices::device_name(name).unwrap_or_else(|e| fail(e.error));
    let scopes = parse_scope_list(scopes).unwrap_or_else(|e| fail(e));
    let events = EventLog::new(store.clone());
    let signed_in = add_token_device(&store, &events, &name, &scopes, None)
        .await
        .unwrap_or_else(|e| fail(e));
    // Only the token goes to stdout, so a caller can capture it as-is.
    println!("{}", signed_in.token);
}

fn fail(message: impl std::fmt::Display) -> ! {
    eprintln!("{message}");
    std::process::exit(1);
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<(Command, PathBuf), String> {
    let args: Vec<String> = args.collect();
    let (device_add, rest) = match args.first().map(String::as_str) {
        Some("device") => match args.get(1).map(String::as_str) {
            Some("add") => (true, &args[2..]),
            _ => return Err("the device command is `device add`".into()),
        },
        _ => (false, &args[..]),
    };
    let (mut config, mut name, mut scopes) = (None, None, None);
    let mut rest = rest.iter();
    while let Some(arg) = rest.next() {
        let mut value = |flag: &str| rest.next().cloned().ok_or(format!("{flag} needs a value"));
        match arg.as_str() {
            "--config" => config = Some(value("--config")?),
            "--name" if device_add => name = Some(value("--name")?),
            "--scopes" if device_add => scopes = Some(value("--scopes")?),
            other => return Err(format!("unknown argument: {other}")),
        }
    }
    let command = if device_add {
        Command::AddDevice {
            name: name.ok_or("device add needs --name")?,
            scopes: scopes.ok_or("device add needs --scopes")?,
        }
    } else {
        Command::Serve
    };
    let config = config
        .map(PathBuf::from)
        .unwrap_or_else(default_config_path);
    Ok((command, config))
}

fn default_config_path() -> PathBuf {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".yarvis").join("server.toml"))
        .unwrap_or_else(|| PathBuf::from("server.toml"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(args: &[&str]) -> Result<(Command, PathBuf), String> {
        parse_args(args.iter().map(|s| s.to_string()))
    }

    #[test]
    fn parses_device_add() {
        let (command, config) = parse(&[
            "device",
            "add",
            "--name",
            "tauri",
            "--scopes",
            "read,chat",
            "--config",
            "x.toml",
        ])
        .unwrap();
        assert!(
            matches!(command, Command::AddDevice { ref name, ref scopes } if name == "tauri" && scopes == "read,chat")
        );
        assert_eq!(config, PathBuf::from("x.toml"));
    }

    #[test]
    fn refuses_device_flags_on_serve_and_missing_ones_on_add() {
        assert!(parse(&["--name", "x"]).is_err());
        assert!(
            parse(&["device", "add", "--name", "x"])
                .unwrap_err()
                .contains("--scopes")
        );
        assert!(parse(&["device", "remove"]).is_err());
        assert!(matches!(parse(&[]).unwrap().0, Command::Serve));
    }
}
