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
    /// Display name for a workspace's agent tab; see `pty::agent_name`.
    pub agent_name: Option<String>,
    /// Base command a workspace's agent session is launched from; see
    /// `pty::agent_command`.
    pub agent_command: Option<String>,
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
    /// given `None`. Rejects a value outside what the core will enforce rather
    /// than storing one and echoing it back, which would show a cap that isn't
    /// the one in force — `pty::resolve_max_sessions` clamps whatever it reads,
    /// so a hand-edited file is still bounded. The in-memory value applies as
    /// soon as it is set; an error means only that it won't survive a restart.
    fn set_max_pty_sessions(&self, value: Option<usize>) -> Result<(), String> {
        match value {
            Some(0) => return Err("the session cap must be at least 1".to_string()),
            Some(n) if n > crate::pty::MAX_CONFIGURABLE_SESSIONS => {
                return Err(format!(
                    "the session cap can be at most {}",
                    crate::pty::MAX_CONFIGURABLE_SESSIONS
                ))
            }
            _ => {}
        }
        {
            let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
            settings.max_pty_sessions = value;
        }
        self.save()
    }

    /// Stores the agent's display name and launch command, clearing either back
    /// to its built-in default when given `None` or a blank string.
    ///
    /// Control characters are rejected. The command is typed into an interactive
    /// shell as a single launch line, so a newline would submit whatever follows
    /// it as a second command — and 0x03/0x15 would do the same by way of the
    /// line editor, for the reasons `pty::is_unsafe_name_char` documents.
    fn set_agent(&self, name: Option<String>, command: Option<String>) -> Result<(), String> {
        let name = non_blank(name);
        let command = non_blank(command);
        if name
            .iter()
            .chain(command.iter())
            .any(|s| s.chars().any(char::is_control))
        {
            return Err(
                "the agent name and command must not contain control characters".to_string(),
            );
        }
        {
            let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
            settings.agent_name = name;
            settings.agent_command = command;
        }
        self.save()
    }
}

/// The trimmed value, or `None` when it is absent or blank — an emptied field in
/// the UI means "use the default", which is stored the same way as never having
/// set one.
fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
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
    default_agent_name: &'static str,
    default_agent_command: &'static str,
    /// True while the agent-command env override is set. That override outranks
    /// the stored command, so the UI says which one is in force rather than
    /// showing a saved value that nothing reads.
    agent_command_overridden_by_env: bool,
}

impl From<Settings> for SettingsView {
    fn from(settings: Settings) -> Self {
        Self {
            settings,
            default_max_pty_sessions: crate::pty::DEFAULT_MAX_SESSIONS,
            max_configurable_pty_sessions: crate::pty::MAX_CONFIGURABLE_SESSIONS,
            default_agent_name: crate::pty::DEFAULT_AGENT_NAME,
            default_agent_command: crate::pty::DEFAULT_AGENT_COMMAND,
            agent_command_overridden_by_env: crate::pty::agent_command_env().is_some(),
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

/// Sets the workspace agent's display name and launch command, clearing either
/// back to its default when given `None` or a blank string. See
/// `SettingsState::set_agent` for what is rejected.
#[tauri::command]
pub fn set_agent(
    state: tauri::State<'_, SettingsState>,
    name: Option<String>,
    command: Option<String>,
) -> Result<SettingsView, String> {
    state.set_agent(name, command)?;
    Ok(state.snapshot().into())
}

#[cfg(test)]
mod tests {
    use super::{Settings, SettingsState, SettingsView};

    /// A settings store over a unique path under the temp dir, so tests touch a
    /// real file (matching how the store is used) without a dev-dependency on a
    /// temp-file crate or interference between tests.
    fn temp_store(name: &str) -> SettingsState {
        // Keyed by pid as well as name so concurrent test binaries don't share
        // a file; the previous run's leftovers are cleared rather than reused.
        let pid = std::process::id();
        let path = std::env::temp_dir().join(format!("yarvis-settings-{pid}-{name}.json"));
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
    fn a_cap_above_the_ceiling_is_rejected_and_nothing_is_stored() {
        let store = temp_store("above-ceiling");
        assert!(store
            .set_max_pty_sessions(Some(crate::pty::MAX_CONFIGURABLE_SESSIONS + 1))
            .is_err());
        assert_eq!(store.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn the_ceiling_itself_is_accepted() {
        let store = temp_store("at-ceiling");
        store
            .set_max_pty_sessions(Some(crate::pty::MAX_CONFIGURABLE_SESSIONS))
            .unwrap();
        assert_eq!(
            store.snapshot().max_pty_sessions,
            Some(crate::pty::MAX_CONFIGURABLE_SESSIONS)
        );
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
        assert!(json["agentName"].is_null());
        assert!(json["agentCommand"].is_null());
        assert_eq!(json["defaultAgentName"], crate::pty::DEFAULT_AGENT_NAME);
        assert_eq!(
            json["defaultAgentCommand"],
            crate::pty::DEFAULT_AGENT_COMMAND
        );
        assert!(json["agentCommandOverriddenByEnv"].is_boolean());
    }

    #[test]
    fn a_stored_agent_survives_a_reload() {
        let store = temp_store("agent-round-trip");
        store
            .set_agent(Some("Codex".to_string()), Some("codex --yolo".to_string()))
            .unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().agent_name.as_deref(), Some("Codex"));
        assert_eq!(
            reloaded.snapshot().agent_command.as_deref(),
            Some("codex --yolo")
        );
    }

    #[test]
    fn a_blank_agent_field_clears_back_to_the_default() {
        let store = temp_store("agent-blank");
        store
            .set_agent(Some("Codex".to_string()), Some("codex --yolo".to_string()))
            .unwrap();
        store.set_agent(Some("   ".to_string()), None).unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().agent_name, None);
        assert_eq!(reloaded.snapshot().agent_command, None);
    }

    #[test]
    fn a_control_character_in_the_agent_command_is_rejected_and_nothing_is_stored() {
        let store = temp_store("agent-controls");
        // A newline submits a second command; 0x03 and 0x15 reach the same shell
        // line through the line editor. See `pty::is_unsafe_name_char`.
        for payload in [
            "claude\nrm -rf /",
            "claude\u{3}rm -rf /",
            "claude\u{15}rm -rf /",
        ] {
            assert!(
                store.set_agent(None, Some(payload.to_string())).is_err(),
                "accepted: {payload:?}"
            );
            assert_eq!(store.snapshot().agent_command, None);
        }
    }
}
