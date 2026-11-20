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

use std::sync::Mutex;

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
    "allow-clipboard-history",
    "allow-clipboard-clear-history",
    "allow-clipboard-write",
    "allow-focus-main-window",
    "allow-fire-alarm",
    "allow-release-alarm",
    // `clipboard-summon` and `omni-chat-summon` reach the page as events.
    "core:event:allow-listen",
    "core:event:allow-unlisten",
    "notification:default",
    "opener:allow-open-url",
];

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

struct Connected {
    origin: String,
    token: String,
}

pub struct ServerLink {
    status: Mutex<Status>,
    connected: Mutex<Option<Connected>>,
    /// The connect page's URL, so the tray can bring it back.
    connect_page: Mutex<Option<Url>>,
    supervisor: Mutex<Option<Supervisor>>,
}

impl ServerLink {
    fn new() -> Self {
        Self {
            status: Mutex::new(Status::Starting),
            connected: Mutex::new(None),
            connect_page: Mutex::new(None),
            supervisor: Mutex::new(None),
        }
    }

    fn set_status(&self, status: Status) {
        *lock(&self.status) = status;
    }

    /// Stops the local server, if this app started one.
    pub fn stop_local_server(&self) {
        if let Some(supervisor) = lock(&self.supervisor).take() {
            supervisor.stop();
        }
    }
}

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
        let link = handle.state::<ServerLink>();
        let status = match connect(&handle).await {
            Ok(Some(found)) => match open(&handle, &found) {
                Ok(()) => {
                    let origin = found.origin.clone();
                    *lock(&link.connected) = Some(found);
                    Status::Connected { origin }
                }
                Err(message) => Status::Failed { message },
            },
            Ok(None) => Status::NeedsSetup,
            Err(message) => Status::Failed { message },
        };
        if let Status::Failed { message } = &status {
            eprintln!("[server] {message}");
        }
        link.set_status(status);
    });
}

fn identifier(app: &AppHandle) -> String {
    app.config().identifier.clone()
}

fn app_data_dir(app: &AppHandle) -> Result<std::path::PathBuf, String> {
    app.path()
        .app_data_dir()
        .map_err(|e| format!("can't locate the app data dir: {e}"))
}

/// Finds the server and its token. `None` means remote mode isn't set up.
async fn connect(app: &AppHandle) -> Result<Option<Connected>, String> {
    let data_dir = app_data_dir(app)?;
    let config = connection::load(&connection::config_path(&data_dir))?;
    match config.mode {
        Mode::Remote => {
            let Some(origin) = config.remote_url else {
                return Ok(None);
            };
            let id = identifier(app);
            let lookup = origin.clone();
            let token =
                tauri::async_runtime::spawn_blocking(move || device_token::get(&id, &lookup))
                    .await
                    .map_err(|e| e.to_string())??;
            Ok(token.map(|token| Connected { origin, token }))
        }
        Mode::Local => start_local(app, config).await.map(Some),
    }
}

/// Starts the bundled server, pairing with it first if this app has no token.
async fn start_local(app: &AppHandle, mut config: ConnectionConfig) -> Result<Connected, String> {
    let data_dir = app_data_dir(app)?;
    std::fs::create_dir_all(&data_dir)
        .map_err(|e| format!("couldn't create {}: {e}", data_dir.display()))?;
    let paths = BundledPaths::locate(app)?;
    if !paths.server_bin.exists() {
        return Err(format!(
            "the server binary is missing at {}",
            paths.server_bin.display()
        ));
    }

    let port = local_server::pick_port(config.local_port)
        .map_err(|e| format!("couldn't find a free port: {e}"))?;
    if config.local_port != Some(port) {
        config.local_port = Some(port);
        connection::save(&connection::config_path(&data_dir), &config)?;
    }

    let server_toml = data_dir.join("server.toml");
    let existing = match std::fs::read_to_string(&server_toml) {
        Ok(text) => text,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
        Err(e) => return Err(format!("couldn't read {}: {e}", server_toml.display())),
    };
    let rendered =
        local_server::render_server_config(&existing, port, &data_dir.join("server"), &paths)?;
    std::fs::write(&server_toml, rendered)
        .map_err(|e| format!("couldn't write {}: {e}", server_toml.display()))?;

    let id = identifier(app);
    let token = {
        let id = id.clone();
        tauri::async_runtime::spawn_blocking(move || device_token::get(&id, device_token::LOCAL))
            .await
            .map_err(|e| e.to_string())??
    };
    let token = match token {
        Some(token) => token,
        None => pair_and_store(&paths, &server_toml, &id).await?,
    };

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
    let token = if local_server::token_accepted(port, &token).await? {
        token
    } else {
        eprintln!("[server] the local server no longer knows this app's device; pairing again");
        let token = pair_and_store(&paths, &server_toml, &id).await?;
        if !local_server::token_accepted(port, &token).await? {
            return Err("the local server refused the token it just issued".into());
        }
        token
    };
    Ok(Connected {
        origin: local_server::origin(port),
        token,
    })
}

async fn pair_and_store(
    paths: &BundledPaths,
    server_toml: &std::path::Path,
    id: &str,
) -> Result<String, String> {
    let token =
        local_server::pair(&paths.server_bin, server_toml, &local_server::device_name()).await?;
    let (id, stored) = (id.to_string(), token.clone());
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
fn open(app: &AppHandle, found: &Connected) -> Result<(), String> {
    let url = Url::parse(&found.origin).map_err(|e| format!("bad server URL: {e}"))?;
    app.add_capability(bridge_capability(&found.origin))
        .map_err(|e| format!("couldn't grant the server's page the bridge: {e}"))?;
    let window = app
        .get_webview_window("main")
        .ok_or("the main window is missing")?;
    window
        .navigate(url)
        .map_err(|e| format!("couldn't load {}: {e}", found.origin))
}

fn bridge_capability(origin: &str) -> CapabilityBuilder {
    BRIDGE_PERMISSIONS.iter().fold(
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

/// The device token the page signs in with. Only the connected server's origin
/// can call this, so the token only ever goes to the server it was issued by.
#[tauri::command]
pub fn get_server_connection(
    link: tauri::State<'_, ServerLink>,
) -> Result<ServerConnection, String> {
    lock(&link.connected)
        .as_ref()
        .map(|c| ServerConnection {
            token: c.token.clone(),
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
    /// A pairing token pasted from the server's Devices page. Optional when
    /// this app already holds one for that server.
    token: Option<String>,
}

/// Saves the choice and restarts the app, which drops the previous server's
/// capability along with everything else.
#[tauri::command(async)]
pub fn save_connection_settings(app: AppHandle, settings: SaveConnection) -> Result<(), String> {
    let path = connection::config_path(&app_data_dir(&app)?);
    let mut config = connection::load(&path)?;
    config.mode = settings.mode;
    if settings.mode == Mode::Remote {
        let raw = settings.remote_url.ok_or("enter the server's URL")?;
        let origin = connection::normalize_remote_url(&raw)?;
        let id = identifier(&app);
        match settings
            .token
            .as_deref()
            .map(str::trim)
            .filter(|t| !t.is_empty())
        {
            Some(token) if token.chars().any(char::is_whitespace) => {
                return Err("the token can't contain spaces".into());
            }
            Some(token) => device_token::set(&id, &origin, token)?,
            None if device_token::get(&id, &origin)?.is_some() => {}
            None => return Err("paste a pairing token from the server's Devices page".into()),
        }
        config.remote_url = Some(origin);
    }
    connection::save(&path, &config)?;
    app.state::<ServerLink>().stop_local_server();
    app.restart();
}

/// Returns from the connect page to the connected server.
#[tauri::command]
pub fn open_server(app: AppHandle, link: tauri::State<'_, ServerLink>) -> Result<(), String> {
    let origin = lock(&link.connected)
        .as_ref()
        .map(|c| c.origin.clone())
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
    /// bridge granted to `SERVER`, as `open` grants it.
    fn context() -> tauri::Context<tauri::test::MockRuntime> {
        let mut context = tauri::generate_context!(test = true);
        context
            .runtime_authority_mut()
            .add_capability(bridge_capability(SERVER))
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
}
