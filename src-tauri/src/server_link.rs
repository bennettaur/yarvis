//! Connects the main window to yarvis-server.
//!
//! The window opens on the app's own connect page (`src-tauri/connect/`),
//! which shows progress and the local/remote choice. Once a server answers,
//! the window navigates to the server's origin, which serves the UI, so every
//! request the UI makes is same-origin.
//!
//! What that origin may call is decided here: it gets a runtime capability
//! naming only the bridge commands (`BRIDGE_PERMISSIONS`). The connect page's
//! own commands stay local-only (`capabilities/default.json`), so a server
//! page can never repoint the app or read another server's token.

use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::ipc::CapabilityBuilder;
use tauri::{AppHandle, Manager, Url};

use crate::connection::{self, ConnectionConfig, Mode};
use crate::device_token;
use crate::local_server::{self, BundledPaths, Supervisor};

/// What a page served by the server may use. Everything else, the connect
/// page's commands included, is refused for that origin.
const BRIDGE_PERMISSIONS: &[&str] = &[
    "allow-get-server-connection",
    "allow-clipboard-clear-history",
    "allow-clipboard-write",
    "allow-focus-main-window",
    "allow-fire-alarm",
    "allow-release-alarm",
    // `clipboard-summon` and `omni-chat-summon` reach the page as events.
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    // Plugins the UI uses for system notifications and opening links.
    "notification:default",
    "opener:allow-open-url",
    // The URLs `open_url` may open: http(s), mailto and tel.
    "opener:allow-default-urls",
];

/// Granted only to the server this app started. Clipboard history holds
/// whatever was copied, passwords included, and the UI hands it to the
/// server for credential screening, so it must not cross the network.
/// Revealing a file in Finder takes a path on the server's machine, which is
/// only this one when the server is local.
const LOCAL_SERVER_PERMISSIONS: &[&str] =
    &["allow-clipboard-history", "opener:allow-reveal-item-in-dir"];

/// How long quitting or switching servers waits for the local server to stop
/// its sidecar and exit.
const STOP_TIMEOUT: Duration = Duration::from_secs(10);

/// What the connect page shows.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "state", rename_all = "camelCase")]
pub enum Status {
    Starting,
    /// Remote mode with no URL or no token yet.
    NeedsSetup,
    Connected {
        origin: String,
    },
    Failed {
        message: String,
    },
}

/// The server the window is using and the token it signs in with.
struct ServerSession {
    /// Where the window loads the UI from, and the only origin given the
    /// bridge: the server itself, or in a dev build the Vite dev server that
    /// proxies `/api` to it.
    page_origin: String,
    token: String,
    /// Started by this app on loopback, rather than a remote server.
    local: bool,
}

pub struct ServerLink {
    status: Mutex<Status>,
    session: Mutex<Option<ServerSession>>,
    /// The connect page's URL, so the tray can bring it back.
    connect_page: Mutex<Option<Url>>,
    supervisor: Mutex<Option<Supervisor>>,
}

impl ServerLink {
    fn new() -> Self {
        Self {
            status: Mutex::new(Status::Starting),
            session: Mutex::new(None),
            connect_page: Mutex::new(None),
            supervisor: Mutex::new(None),
        }
    }

    /// Stops the local server, if this app started one, and waits for it to
    /// exit so the next start can reuse its port.
    pub async fn stop_local_server(&self) {
        let supervisor = lock(&self.supervisor).take();
        if let Some(supervisor) = supervisor {
            if tokio::time::timeout(STOP_TIMEOUT, supervisor.stop())
                .await
                .is_err()
            {
                eprintln!("[server] the local server didn't exit in time");
            }
        }
    }
}

/// Recovers from a poisoned lock: a panic elsewhere must not leave the tray
/// and connect page unable to read the connection.
fn lock<T>(m: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Manages the link's state and starts connecting in the background. Call
/// from `setup`, after the main window exists.
pub fn init(app: &AppHandle) {
    let link = ServerLink::new();
    if let Some(window) = app.get_webview_window("main") {
        *lock(&link.connect_page) = window.url().ok();
    }
    app.manage(link);

    let handle = app.clone();
    tauri::async_runtime::spawn(async move {
        let status = connect_and_open(&handle).await;
        if let Status::Failed { message } = &status {
            eprintln!("[server] {message}");
        }
        *lock(&handle.state::<ServerLink>().status) = status;
    });
}

async fn connect_and_open(app: &AppHandle) -> Status {
    let session = match connect(app).await {
        Ok(Some(session)) => session,
        Ok(None) => return Status::NeedsSetup,
        Err(message) => return Status::Failed { message },
    };
    if let Err(message) = open(app, &session) {
        return Status::Failed { message };
    }
    let origin = session.page_origin.clone();
    *lock(&app.state::<ServerLink>().session) = Some(session);
    Status::Connected { origin }
}

fn identifier(app: &AppHandle) -> String {
    app.config().identifier.clone()
}

fn app_data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("can't locate the app data dir: {e}"))
}

/// Reads a Keychain token off the async runtime: a Keychain access can wait
/// on an authorization prompt.
async fn stored_token(id: String, server: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || device_token::get(&id, &server))
        .await
        .map_err(|e| e.to_string())?
}

/// Finds the server and its token. `None` means remote mode isn't set up.
async fn connect(app: &AppHandle) -> Result<Option<ServerSession>, String> {
    let data_dir = app_data_dir(app)?;
    let config = connection::load(&connection::config_path(&data_dir))?;
    match config.mode {
        Mode::Remote => {
            let Some(origin) = config.remote_url else {
                return Ok(None);
            };
            let token = stored_token(identifier(app), origin.clone()).await?;
            Ok(token.map(|token| ServerSession {
                page_origin: origin,
                token,
                local: false,
            }))
        }
        Mode::Local => start_local(app, &data_dir, config).await.map(Some),
    }
}

/// Starts the bundled server and makes sure this app holds a token it accepts.
async fn start_local(
    app: &AppHandle,
    data_dir: &Path,
    mut config: ConnectionConfig,
) -> Result<ServerSession, String> {
    std::fs::create_dir_all(data_dir)
        .map_err(|e| format!("couldn't create {}: {e}", data_dir.display()))?;
    let paths = BundledPaths::locate(app)?;
    if !paths.server_bin.exists() {
        return Err(format!(
            "the server binary is missing at {}",
            paths.server_bin.display()
        ));
    }

    // Before the server starts: once it has saved a settings.json of its own,
    // the old one is never moved.
    if let Some(target) = crate::legacy_settings::server_settings_path() {
        crate::legacy_settings::migrate(data_dir, &target);
    }
    let (port, previous_port) = local_port(data_dir, &mut config).await?;
    let server_toml = write_server_config(data_dir, port, previous_port, &paths)?;

    let log = app.path().app_log_dir().ok().and_then(|dir| {
        std::fs::create_dir_all(&dir)
            .ok()
            .map(|()| dir.join("server.log"))
    });
    let login_path = server_path().await;
    let (bin, config_arg) = (paths.server_bin.clone(), server_toml.clone());
    let supervisor = Supervisor::start(
        move || {
            let mut cmd = tokio::process::Command::new(&bin);
            cmd.arg("--config").arg(&config_arg);
            if let Some(path) = &login_path {
                cmd.env("PATH", path);
            }
            cmd
        },
        log,
    );
    *lock(&app.state::<ServerLink>().supervisor) = Some(supervisor);
    local_server::wait_healthy(port, local_server::STARTUP_TIMEOUT).await?;

    let id = identifier(app);
    let stored = stored_token(id.clone(), device_token::LOCAL.into()).await?;
    let token = local_server::verified_token(port, stored, || {
        pair_and_store(&paths.server_bin, &server_toml, id)
    })
    .await?;
    Ok(ServerSession {
        page_origin: local_page_origin(port),
        token,
        local: true,
    })
}

/// The port for the local server, and the one it had last run (whose origins
/// `render_server_config` drops). The last port is reused when it is still
/// free, so a browser tab on this Mac keeps working.
#[cfg(not(debug_assertions))]
async fn local_port(
    data_dir: &Path,
    config: &mut ConnectionConfig,
) -> Result<(u16, Option<u16>), String> {
    // Another process could take the port before the server binds it; the
    // health wait then reports a failed start.
    let previous_port = config.local_port;
    let port = local_server::pick_port(previous_port)
        .map_err(|e| format!("couldn't find a free port: {e}"))?;
    if previous_port != Some(port) {
        config.local_port = Some(port);
        connection::save(&connection::config_path(data_dir), config)?;
    }
    Ok((port, previous_port))
}

/// A dev build's server port is fixed above the Vite port, because Vite's
/// `/api` proxy is set up before the app starts. `tauri dev` starts Vite only
/// after `server/` has built, so waiting for Vite also waits for the binary.
/// Nothing is saved: a dev build shares `connection.json` with an installed
/// app of the same identifier.
#[cfg(debug_assertions)]
async fn local_port(
    _data_dir: &Path,
    _config: &mut ConnectionConfig,
) -> Result<(u16, Option<u16>), String> {
    let vite = crate::instance::dev_port();
    let port = crate::instance::dev_server_port()
        .ok_or_else(|| format!("YARVIS_DEV_PORT {vite} leaves no room for the server's port"))?;
    eprintln!("[server] waiting for the Vite dev server on {vite} (it starts once server/ builds)");
    local_server::wait_for_port(vite, VITE_TIMEOUT).await?;
    if std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
        return Err(format!(
            "port {port} is taken; another dev build of Yarvis may still be running"
        ));
    }
    Ok((port, None))
}

/// The first `tauri dev` compiles `server/` before Vite starts.
#[cfg(debug_assertions)]
const VITE_TIMEOUT: Duration = Duration::from_secs(15 * 60);

/// Where the window loads the UI for a local server on `port`.
#[cfg(not(debug_assertions))]
fn local_page_origin(port: u16) -> String {
    local_server::origin(port)
}

/// A dev build loads Vite, for hot reload, and Vite proxies `/api` to the
/// server.
#[cfg(debug_assertions)]
fn local_page_origin(_port: u16) -> String {
    dev_ui_origin()
}

#[cfg(debug_assertions)]
fn dev_ui_origin() -> String {
    format!("http://localhost:{}", crate::instance::dev_port())
}

/// Merges the app's keys into `server.toml` and returns its path.
fn write_server_config(
    data_dir: &Path,
    port: u16,
    previous_port: Option<u16>,
    paths: &BundledPaths,
) -> Result<PathBuf, String> {
    let server_toml = data_dir.join("server.toml");
    let existing = match std::fs::read_to_string(&server_toml) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("couldn't read {}: {e}", server_toml.display())),
    };
    #[cfg(debug_assertions)]
    let dev_ui_origin = Some(dev_ui_origin());
    #[cfg(not(debug_assertions))]
    let dev_ui_origin: Option<String> = None;
    let agent_socket = local_server::onepassword_agent_socket();
    let database_schema = crate::instance::server_schema();
    let rendered = local_server::render_server_config(
        &existing,
        &local_server::ServerConfigInputs {
            port,
            previous_port,
            default_data_dir: &data_dir.join("server"),
            paths,
            agent_socket: agent_socket.as_deref(),
            dev_ui_origin: dev_ui_origin.as_deref(),
            database_schema: database_schema.as_deref(),
        },
    )?;
    std::fs::write(&server_toml, rendered)
        .map_err(|e| format!("couldn't write {}: {e}", server_toml.display()))?;
    Ok(server_toml)
}

async fn pair_and_store(
    server_bin: &Path,
    server_toml: &Path,
    id: String,
) -> Result<String, String> {
    let token = local_server::pair(server_bin, server_toml, &local_server::device_name()).await?;
    let stored = token.clone();
    tauri::async_runtime::spawn_blocking(move || {
        device_token::set(&id, device_token::LOCAL, &stored)
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(token)
}

/// The `PATH` the server, and the sidecar and shells it starts, should have.
/// A release build launched from Finder has launchd's minimal one.
#[cfg(not(debug_assertions))]
async fn server_path() -> Option<String> {
    tauri::async_runtime::spawn_blocking(|| crate::login_path::get().map(str::to_string))
        .await
        .ok()
        .flatten()
}

/// `tauri dev` already has the terminal's `PATH`.
#[cfg(debug_assertions)]
async fn server_path() -> Option<String> {
    None
}

/// Lets the server's origin call the bridge commands, then loads it.
fn open(app: &AppHandle, session: &ServerSession) -> Result<(), String> {
    let url = Url::parse(&session.page_origin).map_err(|e| format!("bad server URL: {e}"))?;
    app.add_capability(bridge_capability(&session.page_origin, session.local))
        .map_err(|e| format!("couldn't grant the server's page the bridge: {e}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing")?;
    window
        .navigate(url)
        .map_err(|e| format!("couldn't load {}: {e}", session.page_origin))
}

fn bridge_capability(origin: &str, local_server: bool) -> CapabilityBuilder {
    let local_only: &[&str] = if local_server {
        LOCAL_SERVER_PERMISSIONS
    } else {
        &[]
    };
    BRIDGE_PERMISSIONS.iter().chain(local_only).fold(
        CapabilityBuilder::new("server-bridge")
            .local(false)
            .remote(format!("{origin}/*"))
            .window("main"),
        |capability, permission| capability.permission(*permission),
    )
}

/// Brings back the connect page, from the tray's "Server connection…".
pub fn show_connect_page(app: &AppHandle) {
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let _ = window.unminimize();
    let _ = window.show();
    let _ = window.set_focus();
    if let Some(url) = lock(&app.state::<ServerLink>().connect_page).clone() {
        let _ = window.navigate(url);
    }
}

// --- Commands for the server's page ---

#[derive(Serialize)]
pub struct ServerConnection {
    token: String,
}

/// The device token the page signs in with. `open` grants this command to the
/// connected server's origin only, so the token only ever goes to the server
/// it was issued by.
#[tauri::command]
pub fn get_server_connection(
    link: tauri::State<'_, ServerLink>,
) -> Result<ServerConnection, String> {
    lock(&link.session)
        .as_ref()
        .map(|s| ServerConnection {
            token: s.token.clone(),
        })
        .ok_or_else(|| "not connected to a server".to_string())
}

// --- Commands for the connect page (local only) ---

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionSettings {
    mode: Mode,
    remote_url: Option<String>,
    status: Status,
}

#[tauri::command]
pub fn get_connection_settings(
    app: AppHandle,
    link: tauri::State<'_, ServerLink>,
) -> Result<ConnectionSettings, String> {
    let config = connection::load(&connection::config_path(&app_data_dir(&app)?))?;
    Ok(ConnectionSettings {
        mode: config.mode,
        remote_url: config.remote_url,
        status: lock(&link.status).clone(),
    })
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveConnection {
    mode: Mode,
    remote_url: Option<String>,
    /// A device token minted on the server's Devices page and pasted in.
    /// Optional when this app already holds one for that server.
    token: Option<String>,
}

/// The config to save and, for a pasted token, the token to store for the
/// remote origin. `has_token` reports whether the app already holds a token
/// for an origin.
fn apply_choice(
    mut config: ConnectionConfig,
    choice: SaveConnection,
    has_token: impl FnOnce(&str) -> Result<bool, String>,
) -> Result<(ConnectionConfig, Option<String>), String> {
    config.mode = choice.mode;
    if choice.mode == Mode::Local {
        // The remote URL stays, so switching back doesn't mean typing it again.
        return Ok((config, None));
    }
    let raw = choice.remote_url.ok_or("enter the server's URL")?;
    let origin = connection::normalize_remote_url(&raw)?;
    let pasted = choice
        .token
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty());
    let to_store = match pasted {
        Some(token) if token.chars().any(char::is_whitespace) => {
            return Err("the token can't contain spaces".into());
        }
        Some(token) => Some(token.to_string()),
        None if has_token(&origin)? => None,
        None => return Err("paste a token from the server's Devices page".into()),
    };
    config.remote_url = Some(origin);
    Ok((config, to_store))
}

/// Saves the choice and restarts the app, which drops the previous server's
/// capability along with everything else. It only returns on an error.
#[tauri::command]
pub async fn save_connection_settings(
    app: AppHandle,
    settings: SaveConnection,
) -> Result<(), String> {
    let path = connection::config_path(&app_data_dir(&app)?);
    let id = identifier(&app);
    let (config, to_store) = apply_choice(connection::load(&path)?, settings, |origin| {
        device_token::get(&id, origin).map(|t| t.is_some())
    })?;
    if let (Some(token), Some(origin)) = (to_store, &config.remote_url) {
        device_token::set(&id, origin, &token)?;
    }
    connection::save(&path, &config)?;
    app.state::<ServerLink>().stop_local_server().await;
    app.restart();
}

/// Returns from the connect page to the connected server.
#[tauri::command]
pub fn open_server(app: AppHandle, link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    let origin = lock(&link.session)
        .as_ref()
        .map(|s| s.page_origin.clone())
        .ok_or("not connected to a server")?;
    let url = Url::parse(&origin).map_err(|e| e.to_string())?;
    app.get_webview_window("main")
        .ok_or("the main window is missing")?
        .navigate(url)
        .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use tauri::ipc::Origin;

    const SERVER: &str = "http://127.0.0.1:7123";

    /// The app's real ACL (build.rs, capabilities/, the plugins) with the
    /// bridge granted to `SERVER`, as `open` grants it to a local server.
    fn context() -> tauri::Context<tauri::test::MockRuntime> {
        let mut context = tauri::generate_context!(test = true);
        context
            .runtime_authority_mut()
            .add_capability(bridge_capability(SERVER, true))
            .expect("every bridge permission exists");
        context
    }

    fn allowed(
        context: &mut tauri::Context<tauri::test::MockRuntime>,
        command: &str,
        origin: &Origin,
    ) -> bool {
        context
            .runtime_authority_mut()
            .resolve_access(command, "main", "main", origin)
            .is_some_and(|cmds| !cmds.is_empty())
    }

    fn remote(url: &str) -> Origin {
        Origin::Remote {
            url: Url::parse(url).unwrap(),
        }
    }

    #[test]
    fn the_servers_page_can_use_the_bridge() {
        let mut context = context();
        let page = remote(&format!("{SERVER}/chat"));
        for command in [
            "get_server_connection",
            "clipboard_history",
            "clipboard_clear_history",
            "clipboard_write",
            "focus_main_window",
            "fire_alarm",
            "release_alarm",
            "plugin:event|listen",
            "plugin:notification|notify",
            "plugin:opener|open_url",
            "plugin:opener|reveal_item_in_dir",
        ] {
            assert!(allowed(&mut context, command, &page), "{command}");
        }
    }

    #[test]
    fn the_servers_page_cannot_repoint_the_app() {
        let mut context = context();
        let page = remote(&format!("{SERVER}/"));
        for command in [
            "get_connection_settings",
            "save_connection_settings",
            "open_server",
            "plugin:window|close",
            "plugin:webview|create_webview_window",
        ] {
            assert!(!allowed(&mut context, command, &page), "{command}");
        }
    }

    #[test]
    fn no_other_origin_gets_the_token() {
        let mut context = context();
        for url in [
            "http://127.0.0.1:7124/",
            "http://localhost:7123/",
            "https://evil.example/",
        ] {
            assert!(
                !allowed(&mut context, "get_server_connection", &remote(url)),
                "{url}"
            );
        }
        assert!(!allowed(
            &mut context,
            "get_server_connection",
            &Origin::Local
        ));
    }

    #[test]
    fn the_connect_page_can_change_the_connection() {
        let mut context = context();
        for command in [
            "get_connection_settings",
            "save_connection_settings",
            "open_server",
        ] {
            assert!(allowed(&mut context, command, &Origin::Local), "{command}");
        }
    }

    fn kebab_permission(command: &str) -> String {
        format!("allow-{}", command.replace('_', "-"))
    }

    #[test]
    fn every_app_command_is_open_to_the_server_only_when_the_bridge_names_it() {
        let mut context = context();
        let page = remote(&format!("{SERVER}/"));
        for command in crate::app_commands::COMMANDS {
            let permission = kebab_permission(command);
            let bridged = BRIDGE_PERMISSIONS.contains(&permission.as_str())
                || LOCAL_SERVER_PERMISSIONS.contains(&permission.as_str());
            assert_eq!(allowed(&mut context, command, &page), bridged, "{command}");
        }
    }

    #[test]
    fn a_remote_server_never_gets_the_clipboard_history_or_finder() {
        let remote_server = "https://yarvis.example.com";
        let mut context = tauri::generate_context!(test = true);
        context
            .runtime_authority_mut()
            .add_capability(bridge_capability(remote_server, false))
            .unwrap();
        let page = remote(&format!("{remote_server}/"));
        assert!(!allowed(&mut context, "clipboard_history", &page));
        assert!(!allowed(
            &mut context,
            "plugin:opener|reveal_item_in_dir",
            &page
        ));
        assert!(allowed(&mut context, "get_server_connection", &page));
        assert!(allowed(&mut context, "clipboard_write", &page));
    }

    // --- The JSON the connect page reads and sends (`connect/connect.js`) ---

    #[test]
    fn status_serializes_as_the_connect_page_reads_it() {
        use serde_json::json;
        let to_json = |s: Status| serde_json::to_value(s).unwrap();
        assert_eq!(to_json(Status::Starting), json!({ "state": "starting" }));
        assert_eq!(
            to_json(Status::NeedsSetup),
            json!({ "state": "needsSetup" })
        );
        assert_eq!(
            to_json(Status::Connected {
                origin: SERVER.into()
            }),
            json!({ "state": "connected", "origin": SERVER })
        );
        assert_eq!(
            to_json(Status::Failed {
                message: "boom".into()
            }),
            json!({ "state": "failed", "message": "boom" })
        );
    }

    fn choice(json: serde_json::Value) -> SaveConnection {
        serde_json::from_value(json).unwrap()
    }

    fn no_token(_: &str) -> Result<bool, String> {
        Ok(false)
    }

    #[test]
    fn a_pasted_token_is_stored_for_the_servers_origin() {
        let (config, token) = apply_choice(
            ConnectionConfig::default(),
            choice(serde_json::json!({
                "mode": "remote",
                "remoteUrl": "https://yarvis.example.com/settings",
                "token": "  tok123 \n",
            })),
            no_token,
        )
        .unwrap();
        assert_eq!(config.mode, Mode::Remote);
        assert_eq!(
            config.remote_url.as_deref(),
            Some("https://yarvis.example.com")
        );
        assert_eq!(token.as_deref(), Some("tok123"));
    }

    #[test]
    fn a_token_with_spaces_inside_is_refused() {
        let err = apply_choice(
            ConnectionConfig::default(),
            choice(serde_json::json!({
                "mode": "remote",
                "remoteUrl": "https://yarvis.example.com",
                "token": "tok 123",
            })),
            no_token,
        )
        .unwrap_err();
        assert!(err.contains("spaces"), "{err}");
    }

    #[test]
    fn a_blank_token_needs_one_already_saved_for_that_server() {
        let remote = || {
            choice(serde_json::json!({
                "mode": "remote",
                "remoteUrl": "https://yarvis.example.com",
                "token": "  ",
            }))
        };
        assert!(apply_choice(ConnectionConfig::default(), remote(), no_token).is_err());

        let (config, token) = apply_choice(ConnectionConfig::default(), remote(), |origin| {
            Ok(origin == "https://yarvis.example.com")
        })
        .unwrap();
        assert_eq!(config.mode, Mode::Remote);
        assert_eq!(token, None);
    }

    #[test]
    fn an_insecure_remote_url_is_refused_before_anything_is_saved() {
        let result = apply_choice(
            ConnectionConfig::default(),
            choice(serde_json::json!({
                "mode": "remote",
                "remoteUrl": "http://yarvis.example.com",
                "token": "tok",
            })),
            no_token,
        );
        assert!(result.is_err());
    }

    #[test]
    fn switching_to_local_keeps_the_remote_url_for_later() {
        let saved = ConnectionConfig {
            mode: Mode::Remote,
            remote_url: Some("https://yarvis.example.com".into()),
            local_port: Some(7123),
        };
        let (config, token) = apply_choice(
            saved,
            choice(serde_json::json!({ "mode": "local", "remoteUrl": null, "token": null })),
            |_| panic!("local mode needs no token"),
        )
        .unwrap();
        assert_eq!(config.mode, Mode::Local);
        assert_eq!(
            config.remote_url.as_deref(),
            Some("https://yarvis.example.com")
        );
        assert_eq!(config.local_port, Some(7123));
        assert_eq!(token, None);
    }
}
