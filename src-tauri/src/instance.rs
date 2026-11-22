//! Instance profiles, so several Yarvis builds can run side by side.
//!
//! An instance is named by `YARVIS_INSTANCE`; absent, the process is the
//! primary one. The name also selects the bundle identifier (see
//! `scripts/dev-instance.ts`), and Tauri derives the app data directory and the
//! single-instance socket from that identifier, so each instance gets its own
//! `connection.json`, local server, server data and Keychain device token
//! without any work here.
//!
//! What does not separate on its own is the global hotkeys only one process
//! can hold. Those default to the primary instance and are opt-in elsewhere.
//! Nor do a dev build's Vite and local server ports, which the launcher moves
//! with `YARVIS_DEV_PORT`. The local server inherits this process's environment, so
//! `YARVIS_INSTANCE`, `YARVIS_BACKGROUND_WORKERS` and `YARVIS_DATABASE_URL`
//! reach it and the sidecar it starts unchanged.

/// Name reported by a process that was never given one.
const PRIMARY: &str = "main";

/// Port the Vite dev server uses when no instance moved it. Matches
/// `vite.config.ts`.
const DEFAULT_DEV_PORT: u16 = 1420;

/// In a dev build the local server listens this far above the Vite port, so
/// Vite's `/api` proxy knows where it is before the app starts it. Matches
/// `vite.config.ts` and `scripts/dev-instance.ts`.
const DEV_SERVER_PORT_OFFSET: u16 = 6000;

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

/// The schema a named instance's local server keeps its tables in. Instances
/// can share one database, and on a shared schema the second would share the
/// first's account and devices, and deny its pending approvals as left over
/// on every start. `None` for the primary, which uses the server's default.
pub fn server_schema() -> Option<String> {
    (!is_primary()).then(|| schema_for(&name()))
}

fn schema_for(name: &str) -> String {
    let slug: String = name
        .chars()
        .map(|c| match c.to_ascii_lowercase() {
            c @ ('a'..='z' | '0'..='9') => c,
            _ => '_',
        })
        .take(40)
        .collect();
    format!("yarvis_server_{slug}")
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

/// Parses the Vite dev-server port. Anything that isn't a port falls back to
/// the default rather than propagating: the value becomes an origin in the
/// server's `auth.origins` and the bridge capability, so a comma or a host in
/// it would otherwise widen both.
fn resolve_dev_port(raw: Option<&str>) -> u16 {
    raw.and_then(|p| p.trim().parse::<u16>().ok())
        .unwrap_or(DEFAULT_DEV_PORT)
}

/// The Vite dev server this instance's window loads in a dev build. The
/// launcher sets it (see `scripts/dev-instance.ts`) because the default one is
/// already taken.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn dev_port() -> u16 {
    resolve_dev_port(env_value("YARVIS_DEV_PORT").as_deref())
}

/// The port the local server listens on in a dev build. `None` when the dev
/// port is too high to leave room above it.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
pub fn dev_server_port() -> Option<u16> {
    dev_port().checked_add(DEV_SERVER_PORT_OFFSET)
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

#[cfg(test)]
mod tests {

    #[test]
    fn an_instance_schema_is_a_plain_name() {
        assert_eq!(schema_for("migration-test"), "yarvis_server_migration_test");
        assert_eq!(schema_for("Ünï Cödé"), "yarvis_server__n__c_d_");
    }

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
        assert_eq!(resolve_dev_port(Some(" 1437 ")), 1437);
    }

    #[test]
    fn a_dev_port_that_could_widen_the_origin_list_is_refused() {
        assert_eq!(
            resolve_dev_port(Some("1420,https://evil.example")),
            DEFAULT_DEV_PORT
        );
        assert_eq!(
            resolve_dev_port(Some("1420 https://evil.example")),
            DEFAULT_DEV_PORT
        );
        assert_eq!(resolve_dev_port(Some("99999999999")), DEFAULT_DEV_PORT);
    }
}
