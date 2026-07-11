mod alarms;
mod control;
mod custom_providers;
mod embeddings_secrets;
mod keychain;
mod pty;
mod sidecar;

/// Global hotkey that summons the Omni Chat overlay from anywhere.
#[cfg(desktop)]
const OMNI_CHAT_SHORTCUT: &str = "Control+Shift+Space";

/// Brings the main window forward and tells the frontend to open Omni Chat.
/// Unlike an alarm it does not fullscreen or pin the window — it's a transient
/// summon the user dismisses with Esc.
#[cfg(desktop)]
fn summon_omni_chat(app: &tauri::AppHandle) {
    use tauri::{Emitter, Manager};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit("omni-chat-summon", ());
}

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

    #[cfg(desktop)]
    {
        use tauri_plugin_global_shortcut::ShortcutState;
        let shortcut: tauri_plugin_global_shortcut::Shortcut = OMNI_CHAT_SHORTCUT
            .parse()
            .expect("OMNI_CHAT_SHORTCUT is a valid accelerator");
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, scut, event| {
                    if scut == &shortcut && event.state() == ShortcutState::Pressed {
                        summon_omni_chat(app);
                    }
                })
                .build(),
        );
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
            // Bind the control channel before spawning the sidecar so its socket
            // path is available to inject into the sidecar's environment.
            if let Err(e) = control::init(app.handle()) {
                eprintln!("[control] init failed: {e}");
            }
            if let Err(e) = sidecar::init(app.handle()) {
                eprintln!("[sidecar] init failed: {e}");
            }
            if let Err(e) = alarms::init(app.handle()) {
                eprintln!("[alarms] init failed: {e}");
            }
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if let Err(e) = app.global_shortcut().register(OMNI_CHAT_SHORTCUT) {
                    eprintln!("[omni-chat] global shortcut registration failed: {e}");
                }
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
            embeddings_secrets::get_embeddings_secret_status,
            embeddings_secrets::set_embeddings_secret,
            embeddings_secrets::delete_embeddings_secret,
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
            pty::pty_exists,
            pty::pty_start_claude,
            pty::pty_is_busy,
            pty::get_claude_command,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
