//! Instance profiles, so several Yarvis builds can run side by side.
//!
//! An instance is named by `YARVIS_INSTANCE`; absent, the process is the
//! primary one. The name also selects the bundle identifier (see
//! `scripts/dev-instance.ts`), and Tauri derives the app data directory and the
//! single-instance socket from that identifier — so `settings.json`,
//! `alarms.json` and `core-control.sock` separate without any work here.
//!
//! What does not separate on its own is anything singular to the machine or to
//! the shared database: the global hotkeys only one process can hold, and the
//! sidecar's background workers, which on a shared database would poll the same
//! providers twice and can resume the same workspace kick-off from two
//! processes at once. Those default to the primary instance and are opt-in
//! elsewhere.
//!
//! Secrets are deliberately *not* separated: the Keychain item is keyed by a
//! fixed service name (`keychain.rs`), so every instance reads the same
//! provider credentials. A secondary instance that needs its own database —
//! testing a migration without touching the primary's data — overrides just
//! that one value with `YARVIS_DATABASE_URL`.

/// Name reported by a process that was never given one.
const PRIMARY: &str = "main";

/// Port the Vite dev server uses when no instance moved it. Matches
/// `vite.config.ts` and `tauri.conf.json`'s `devUrl`.
const DEFAULT_DEV_PORT: u16 = 1420;

/// Reads an env var, treating an empty value as unset so an exported-but-blank
/// variable behaves the same as no variable at all.
fn env_value(key: &str) -> Option<String> {
    std::env::var(key).ok().filter(|v| !v.trim().is_empty())
}

/// Parses an explicit on/off override. An unrecognized value — including a typo
/// — is `None` rather than `false`, leaving the caller's default in place: a
/// flag only overrides when it plainly says which way.
fn parse_flag(raw: Option<&str>) -> Option<bool> {
    match raw.map(str::trim) {
        Some("1" | "true") => Some(true),
        Some("0" | "false") => Some(false),
        _ => None,
    }
}

/// Resolves the instance name from the raw env value.
fn resolve_name(raw: Option<&str>) -> String {
    match raw.map(str::trim).filter(|v| !v.is_empty()) {
        Some(name) => name.to_string(),
        None => PRIMARY.to_string(),
    }
}

/// This process's instance name.
pub fn name() -> String {
    resolve_name(env_value("YARVIS_INSTANCE").as_deref())
}

/// Whether this process is the primary instance. Keyed on the *absence* of a
/// name rather than on its value: a launcher-started instance has its own bundle
/// identifier and data directory no matter what it is called, so
/// `dev:instance main` must not thereby claim the hotkeys and the background
/// work that belong to the app the user actually runs.
fn is_primary() -> bool {
    env_value("YARVIS_INSTANCE").is_none()
}

/// Resolves a capability the primary instance owns by default, which an explicit
/// flag can hand either way.
fn primary_owned(flag: Option<&str>, owned_by_default: bool) -> bool {
    parse_flag(flag).unwrap_or(owned_by_default)
}

/// Whether to register the app-wide hotkeys. Only one process can hold a given
/// accelerator, so a secondary instance stays out of the way unless asked.
pub fn global_shortcuts_enabled() -> bool {
    primary_owned(
        env_value("YARVIS_GLOBAL_SHORTCUTS").as_deref(),
        is_primary(),
    )
}

/// Whether the sidecar should run its background workers (Telegram bot,
/// workspace poller, interrupted kick-off resume, guide sweep). Passed to the
/// sidecar rather than decided there so the answer is instance policy, made in
/// one place.
pub fn background_workers_enabled() -> bool {
    primary_owned(
        env_value("YARVIS_BACKGROUND_WORKERS").as_deref(),
        is_primary(),
    )
}

/// Parses the dev-server port this instance's webview loads from. Anything that
/// isn't a port falls back to the default rather than propagating: the value is
/// interpolated into the sidecar's allowed-origins list, so a comma in it would
/// otherwise append an origin of the caller's choosing.
fn resolve_dev_port(raw: Option<&str>) -> u16 {
    raw.and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_DEV_PORT)
}

/// The dev-server port this instance's webview loads from; the launcher sets it
/// (see `scripts/dev-instance.ts`) because the default one is already taken.
pub fn dev_port() -> u16 {
    resolve_dev_port(env_value("YARVIS_DEV_PORT").as_deref())
}

/// Marks a secondary instance's window with its name. Two instances are
/// otherwise identical on screen, and picking the wrong window is how a test
/// lands in the app holding the real data.
pub fn label_window(app: &tauri::AppHandle) {
    use tauri::Manager;
    if is_primary() {
        return;
    }
    let Some(window) = app.get_webview_window("main") else {
        return;
    };
    let title = window.title().unwrap_or_else(|_| "Yarvis".to_string());
    if let Err(e) = window.set_title(&format!("{title} ({})", name())) {
        eprintln!("[instance] could not label the window: {e}");
    }
}

/// A database URL that overrides the one stored in the Keychain, letting a
/// secondary instance run against its own database — so a migration under
/// development can't reach the primary's data — while still sharing every other
/// secret.
pub fn database_url_override() -> Option<String> {
    env_value("YARVIS_DATABASE_URL")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unset_or_blank_name_is_the_primary_instance() {
        assert_eq!(resolve_name(None), PRIMARY);
        assert_eq!(resolve_name(Some("  ")), PRIMARY);
    }

    #[test]
    fn a_named_instance_is_trimmed() {
        assert_eq!(resolve_name(Some(" feature-x ")), "feature-x");
    }

    #[test]
    fn flags_recognize_only_explicit_values() {
        assert_eq!(parse_flag(Some("1")), Some(true));
        assert_eq!(parse_flag(Some("true")), Some(true));
        assert_eq!(parse_flag(Some("0")), Some(false));
        assert_eq!(parse_flag(Some("false")), Some(false));
        assert_eq!(parse_flag(Some("yes")), None);
        assert_eq!(parse_flag(None), None);
    }

    #[test]
    fn a_primary_owned_capability_follows_the_instance_unless_forced() {
        assert!(primary_owned(None, true));
        assert!(!primary_owned(None, false));
        assert!(primary_owned(Some("1"), false));
        assert!(!primary_owned(Some("0"), true));
    }

    #[test]
    fn an_unset_dev_port_falls_back_to_the_default() {
        assert_eq!(resolve_dev_port(None), DEFAULT_DEV_PORT);
        assert_eq!(resolve_dev_port(Some("  ")), DEFAULT_DEV_PORT);
    }

    #[test]
    fn a_dev_port_is_used_as_given() {
        assert_eq!(resolve_dev_port(Some("1437")), 1437);
        assert_eq!(resolve_dev_port(Some(" 1437 ")), 1437);
    }

    #[test]
    fn a_dev_port_that_could_widen_the_origin_list_is_refused() {
        // A comma would otherwise append a second origin to the allowlist.
        assert_eq!(
            resolve_dev_port(Some("1420,https://evil.example")),
            DEFAULT_DEV_PORT
        );
        assert_eq!(
            resolve_dev_port(Some("1420 https://evil.example")),
            DEFAULT_DEV_PORT
        );
    }

    #[test]
    fn a_dev_port_outside_the_port_range_falls_back_to_the_default() {
        assert_eq!(resolve_dev_port(Some("99999999999")), DEFAULT_DEV_PORT);
        assert_eq!(resolve_dev_port(Some("-1")), DEFAULT_DEV_PORT);
    }
}
