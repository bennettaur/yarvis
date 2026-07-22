//! User-editable settings owned by the Rust core.
//!
//! Non-secret preferences for behaviour the core implements, persisted as
//! `settings.json` in the app data directory beside `alarms.json` and written
//! with the same atomic rename. Secrets belong in the Keychain
//! (`keychain.rs`) and settings the sidecar owns belong in its database; this
//! is only for values the core itself reads, so the frontend can change them
//! without the core having to ask the sidecar.

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};

/// The persisted settings document. Every field is optional and absent means
/// "use the built-in default", so a settings file written by an older build
/// stays readable and an unset field never has to encode a default that then
/// drifts from the one in code.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Cap on live PTY sessions; see `pty::max_sessions`.
    pub max_pty_sessions: Option<usize>,
}

pub struct SettingsState {
    settings: Mutex<Settings>,
    path: PathBuf,
}

impl SettingsState {
    fn load(path: PathBuf) -> Self {
        // A malformed file falls back to defaults rather than failing startup;
        // the next write replaces it.
        let settings = std::fs::read_to_string(&path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default();
        Self {
            settings: Mutex::new(settings),
            path,
        }
    }

    /// Persists the current settings, reporting failure to the caller — unlike
    /// the alarm store this mirrors, every write here is one the user asked for
    /// and is told about, so a silent failure would report a change as saved
    /// that then reverts on the next launch.
    fn save(&self) -> Result<(), String> {
        let settings = self.snapshot();
        let json = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
        // Atomic write: serialize to a sibling file then rename over the target
        // so a crash mid-write can't leave settings.json truncated.
        let tmp = self.path.with_extension("json.tmp");
        std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, &self.path).map_err(|e| e.to_string())
    }

    /// A copy of the current settings, treating a poisoned lock as defaults so a
    /// panic elsewhere can't wedge every reader. Writes take the opposite line
    /// and surface the poisoning, since silently discarding one is worse than
    /// reporting it.
    pub fn snapshot(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// Stores the live-PTY-session cap, or clears it back to the default when
    /// given `None`. Rejects zero rather than storing a value that would make
    /// every terminal unopenable. The in-memory value applies as soon as it is
    /// set; an error means only that it won't survive a restart.
    fn set_max_pty_sessions(&self, value: Option<usize>) -> Result<(), String> {
        if value == Some(0) {
            return Err("the session cap must be at least 1".to_string());
        }
        {
            let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
            settings.max_pty_sessions = value;
        }
        self.save()
    }
}

/// Loads persisted settings into managed state. Call from `setup`.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let _ = std::fs::create_dir_all(&dir);
    app.manage(SettingsState::load(dir.join("settings.json")));
    Ok(())
}

/// What the frontend gets back: the stored settings plus the defaults an unset
/// field falls back to, so the UI can show what "unset" actually means without
/// repeating constants that then drift from the ones the core enforces.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    default_max_pty_sessions: usize,
    max_configurable_pty_sessions: usize,
}

impl From<Settings> for SettingsView {
    fn from(settings: Settings) -> Self {
        Self {
            settings,
            default_max_pty_sessions: crate::pty::DEFAULT_MAX_SESSIONS,
            max_configurable_pty_sessions: crate::pty::MAX_CONFIGURABLE_SESSIONS,
        }
    }
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> SettingsView {
    state.snapshot().into()
}

/// Sets the live-PTY-session cap, or clears it back to the default when given
/// `None`. See `SettingsState::set_max_pty_sessions` for what is rejected.
#[tauri::command]
pub fn set_max_pty_sessions(
    state: tauri::State<'_, SettingsState>,
    value: Option<usize>,
) -> Result<SettingsView, String> {
    state.set_max_pty_sessions(value)?;
    Ok(state.snapshot().into())
}

#[cfg(test)]
mod tests {
    use super::{Settings, SettingsState, SettingsView};

    /// A settings store over a unique path under the temp dir, so tests touch a
    /// real file (matching how the store is used) without a dev-dependency on a
    /// temp-file crate or interference between tests.
    fn temp_store(name: &str) -> SettingsState {
        let path = std::env::temp_dir().join(format!("yarvis-settings-{name}.json"));
        let _ = std::fs::remove_file(&path);
        SettingsState::load(path)
    }

    #[test]
    fn a_stored_cap_survives_a_reload() {
        let store = temp_store("round-trip");
        store.set_max_pty_sessions(Some(120)).unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().max_pty_sessions, Some(120));
    }

    #[test]
    fn clearing_the_cap_survives_a_reload() {
        let store = temp_store("round-trip-cleared");
        store.set_max_pty_sessions(Some(120)).unwrap();
        store.set_max_pty_sessions(None).unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn a_malformed_file_loads_as_defaults() {
        let store = temp_store("malformed");
        std::fs::write(&store.path, "not json").unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn a_zero_cap_is_rejected_and_nothing_is_stored() {
        let store = temp_store("zero");
        assert!(store.set_max_pty_sessions(Some(0)).is_err());
        assert_eq!(store.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn the_view_carries_the_keys_the_frontend_reads() {
        // The camelCase names in `lib/settings.ts` exist only by way of serde's
        // rename and the flattened inner struct, which a round-trip through
        // serde alone would not catch — both directions would rename together.
        let json = serde_json::to_value(SettingsView::from(Settings::default())).unwrap();
        assert!(json["maxPtySessions"].is_null());
        assert_eq!(
            json["defaultMaxPtySessions"],
            crate::pty::DEFAULT_MAX_SESSIONS
        );
        assert_eq!(
            json["maxConfigurablePtySessions"],
            crate::pty::MAX_CONFIGURABLE_SESSIONS
        );
    }
}
