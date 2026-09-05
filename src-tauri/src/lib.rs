mod alarms;
mod clipboard;
mod control;
mod custom_providers;
mod embeddings_secrets;
mod instance;
mod keychain;
mod mcp;
mod pty;
mod settings;
mod sidecar;

/// Global hotkey that summons the Omni Chat overlay from anywhere.
#[cfg(desktop)]
const OMNI_CHAT_SHORTCUT: &str = "Control+Shift+Space";

/// Global hotkey that summons the clipboard palette from anywhere.
#[cfg(desktop)]
const CLIPBOARD_SHORTCUT: &str = "Control+Shift+V";

/// Brings the main window forward and tells the frontend to open the named
/// overlay. Unlike an alarm it does not fullscreen or pin the window — it's a
/// transient summon the user dismisses with Esc.
#[cfg(desktop)]
fn summon_overlay(app: &tauri::AppHandle, event: &str) {
    use tauri::{Emitter, Manager};
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
    let _ = app.emit(event, ());
}

/// Brings the main window to the foreground. Invoked when the user clicks an
/// attention item so the app surfaces even if it was minimized or behind another
/// window. Mirrors the window handling in `summon_overlay`, without the
/// overlay-specific emit.
#[tauri::command]
fn focus_main_window(app: tauri::AppHandle) {
    use tauri::Manager;
    match app.get_webview_window("main") {
        Some(window) => {
            let _ = window.unminimize();
            let _ = window.show();
            let _ = window.set_focus();
        }
        None => eprintln!("[app] focus_main_window: main window not found"),
    }
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
        let omni_chat: tauri_plugin_global_shortcut::Shortcut = OMNI_CHAT_SHORTCUT
            .parse()
            .expect("OMNI_CHAT_SHORTCUT is a valid accelerator");
        let clipboard: tauri_plugin_global_shortcut::Shortcut = CLIPBOARD_SHORTCUT
            .parse()
            .expect("CLIPBOARD_SHORTCUT is a valid accelerator");
        builder = builder.plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(move |app, scut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if scut == &omni_chat {
                        summon_overlay(app, "omni-chat-summon");
                    } else if scut == &clipboard {
                        summon_overlay(app, "clipboard-summon");
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
            instance::label_window(app.handle());
            app.manage(pty::PtyState::default());
            if let Err(e) = settings::init(app.handle()) {
                eprintln!("[settings] init failed: {e}");
            }
            embeddings_secrets::migrate_legacy_item();
            #[cfg(unix)]
            if let Err(e) = pty::raise_fd_limit() {
                eprintln!("[pty] raising the file descriptor limit failed: {e}");
            }
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
            clipboard::init(app.handle());
            #[cfg(desktop)]
            {
                use tauri_plugin_global_shortcut::GlobalShortcutExt;
                if instance::global_shortcuts_enabled() {
                    if let Err(e) = app.global_shortcut().register(OMNI_CHAT_SHORTCUT) {
                        eprintln!("[omni-chat] global shortcut registration failed: {e}");
                    }
                    if let Err(e) = app.global_shortcut().register(CLIPBOARD_SHORTCUT) {
                        eprintln!("[clipboard] global shortcut registration failed: {e}");
                    }
                } else {
                    eprintln!(
                        "[instance] '{}' left the global hotkeys to the primary instance; \
                         set YARVIS_GLOBAL_SHORTCUTS=1 to claim them",
                        instance::name()
                    );
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
            mcp::list_mcp_secret_status,
            mcp::set_mcp_secret,
            mcp::delete_mcp_secret,
            mcp::delete_mcp_all_secrets,
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
            clipboard::clipboard_history,
            clipboard::clipboard_clear_history,
            clipboard::clipboard_write,
            pty::pty_attach,
            pty::pty_write,
            pty::pty_resize,
            pty::pty_kill,
            pty::pty_exists,
            pty::pty_start_claude,
            pty::pty_is_busy,
            pty::get_agent_config,
            focus_main_window,
            settings::get_settings,
            settings::set_max_pty_sessions,
            settings::set_agent,
            settings::set_azure_devops_org_url,
            settings::set_jira_base_url,
            settings::set_jira_email,
            settings::set_google_client_id,
            settings::set_telegram_otp_window_minutes,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
