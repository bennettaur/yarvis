mod alarms;
mod custom_providers;
mod keychain;
mod pty;
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
            use tauri::Manager;
            app.manage(pty::PtyState::default());
            if let Err(e) = sidecar::init(app.handle()) {
                eprintln!("[sidecar] init failed: {e}");
            }
            if let Err(e) = alarms::init(app.handle()) {
                eprintln!("[alarms] init failed: {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            keychain::set_secret,
            keychain::get_secret_status,
            keychain::delete_secret,
            keychain::list_secret_status,
            custom_providers::list_custom_provider_secret_status,
            custom_providers::set_custom_provider_secret,
            custom_providers::delete_custom_provider_secret,
            custom_providers::delete_custom_provider_all_secrets,
            sidecar::get_sidecar_info,
            sidecar::restart_sidecar,
            alarms::list_alarms,
            alarms::create_alarm,
            alarms::cancel_alarm,
            alarms::acknowledge_alarm,
            alarms::snooze_alarm,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
