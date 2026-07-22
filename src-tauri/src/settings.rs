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
    #[serde(default)]
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

    fn save(&self) {
        if let Ok(settings) = self.settings.lock() {
            if let Ok(json) = serde_json::to_string_pretty(&*settings) {
                // Atomic write: serialize to a sibling file then rename over the
                // target so a crash mid-write can't leave settings.json truncated.
                let tmp = self.path.with_extension("json.tmp");
                if std::fs::write(&tmp, json).is_ok() {
                    let _ = std::fs::rename(&tmp, &self.path);
                }
            }
        }
    }

    /// A copy of the current settings, treating a poisoned lock as defaults so a
    /// panic elsewhere can't wedge every reader.
    pub fn snapshot(&self) -> Settings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
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
}

impl SettingsView {
    fn of(settings: Settings) -> Self {
        Self {
            settings,
            default_max_pty_sessions: crate::pty::DEFAULT_MAX_SESSIONS,
        }
    }
}

#[tauri::command]
pub fn get_settings(state: tauri::State<'_, SettingsState>) -> SettingsView {
    SettingsView::of(state.snapshot())
}

/// Sets the live-PTY-session cap, or clears it back to the default when given
/// `None`. Rejects zero rather than storing a value that would make every
/// terminal unopenable.
#[tauri::command]
pub fn set_max_pty_sessions(
    state: tauri::State<'_, SettingsState>,
    value: Option<usize>,
) -> Result<SettingsView, String> {
    if value == Some(0) {
        return Err("the session cap must be at least 1".to_string());
    }
    {
        let mut settings = state.settings.lock().map_err(|e| e.to_string())?;
        settings.max_pty_sessions = value;
    }
    state.save();
    Ok(SettingsView::of(state.snapshot()))
}
