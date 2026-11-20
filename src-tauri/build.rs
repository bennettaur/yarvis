/// The app's own commands. Listing them makes each one a permission
/// (`allow-<command>`), so a command is callable only from an origin whose
/// capability names it: the connect page's in `capabilities/default.json`, the
/// server's page's in `server_link::BRIDGE_PERMISSIONS`.
const COMMANDS: &[&str] = &[
    "get_server_connection",
    "get_connection_settings",
    "save_connection_settings",
    "open_server",
    "fire_alarm",
    "release_alarm",
    "clipboard_history",
    "clipboard_clear_history",
    "clipboard_write",
    "focus_main_window",
];

fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new()
            .app_manifest(tauri_build::AppManifest::new().commands(COMMANDS)),
    )
    .expect("failed to run tauri-build");
}
