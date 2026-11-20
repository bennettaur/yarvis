//! The thin desktop client: the window, tray, global hotkeys, clipboard
//! history and alarm takeovers. Everything else (settings, secrets, PTYs, the
//! sidecar) belongs to yarvis-server, which this app either starts locally or
//! reaches at a remote URL (`server_link.rs`).

mod alarms;
mod clipboard;
mod connection;
mod device_token;
mod instance;
mod local_server;
// Only a release build reads it; `tauri dev` already has the terminal's `PATH`.
#[cfg_attr(debug_assertions, allow(dead_code))]
mod login_path;
mod server_link;

/// Global hotkey that summons the Omni Chat overlay from anywhere.
#[cfg(desktop)]
const OMNI_CHAT_SHORTCUT: &str = "Control+Shift+Space";

/// Global hotkey that summons the clipboard palette from anywhere.
#[cfg(desktop)]
const CLIPBOARD_SHORTCUT: &str = "Control+Shift+V";

/// Tray menu item ids.
#[cfg(desktop)]
const TRAY_OPEN: &str = "open";
#[cfg(desktop)]
const TRAY_CONNECTION: &str = "connection";
#[cfg(desktop)]
const TRAY_QUIT: &str = "quit";

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

/// The tray menu: reopen the window, change which server it talks to, quit.
#[cfg(desktop)]
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder};
    use tauri::tray::TrayIconBuilder;

    let menu = MenuBuilder::new(app)
        .item(&MenuItemBuilder::with_id(TRAY_OPEN, "Open Yarvis").build(app)?)
        .item(&MenuItemBuilder::with_id(TRAY_CONNECTION, "Server connection…").build(app)?)
        .separator()
        .item(&MenuItemBuilder::with_id(TRAY_QUIT, "Quit Yarvis").build(app)?)
        .build()?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Yarvis")
        .menu(&menu)
        .on_menu_event(|app, event| match event.id().as_ref() {
            TRAY_OPEN => focus_main_window(app.clone()),
            TRAY_CONNECTION => server_link::show_connect_page(app),
            TRAY_QUIT => app.exit(0),
            _ => {}
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;
    Ok(())
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
            instance::label_window(app.handle());
            alarms::init(app.handle());
            clipboard::init(app.handle());
            server_link::init(app.handle());
            #[cfg(desktop)]
            {
                if let Err(e) = build_tray(app) {
                    eprintln!("[tray] couldn't create the tray icon: {e}");
                }
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
        // Every command here must also be listed in `build.rs`, which is what
        // lets the capabilities decide which origin may call it.
        .invoke_handler(tauri::generate_handler![
            server_link::get_server_connection,
            server_link::get_connection_settings,
            server_link::save_connection_settings,
            server_link::open_server,
            alarms::fire_alarm,
            alarms::release_alarm,
            clipboard::clipboard_history,
            clipboard::clipboard_clear_history,
            clipboard::clipboard_write,
            focus_main_window,
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The local server would otherwise outlive the app and keep its port.
            if let tauri::RunEvent::Exit = event {
                use tauri::Manager;
                app.state::<server_link::ServerLink>().stop_local_server();
            }
        });
}
