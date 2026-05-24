mod keychain;
mod sidecar;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // The single-instance plugin must be registered first so a second launch is
    // intercepted before other plugins initialize.
    #[cfg(desktop)]
    {
        use tauri::Manager;
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }));
    }

    builder = builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init());

    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_autostart::init(
            tauri_plugin_autostart::MacosLauncher::LaunchAgent,
            None,
        ));
    }

    builder
        .setup(|app| {
            if let Err(e) = sidecar::init(app.handle()) {
                eprintln!("[sidecar] init failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain::set_secret,
            keychain::get_secret_status,
            keychain::delete_secret,
            keychain::list_secret_status,
            sidecar::get_sidecar_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
