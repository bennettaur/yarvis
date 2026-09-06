//! User-editable settings owned by the Rust core.
//!
//! Non-secret preferences, persisted as `settings.json` in `~/.yarvis` — the
//! same home-directory convention the sidecar uses for `~/.yarvis/agents` —
//! written with an atomic rename. Secrets belong in the Keychain
//! (`keychain.rs`) and settings the sidecar owns belong in its database; this
//! is only for values the core itself reads or injects into the sidecar's
//! environment, so the frontend can change them without the core having to ask
//! the sidecar.
//!
//! The file is shared across `dev:instance` copies the same way the Keychain
//! item is, so every setter re-reads it before merging in its one field rather
//! than writing straight from this process's in-memory snapshot — the same
//! read-before-write discipline `custom_providers.rs`/`mcp.rs` use for their
//! nested subtrees of the shared Keychain blob. That narrows, but doesn't
//! close, the window: two instances saving at nearly the same moment can still
//! clobber each other, since there's no file lock — only genuinely concurrent
//! writes lose data now, rather than any save from a longer-running instance
//! reverting whatever a newer one wrote since it started.
//!
//! A handful of fields (the `azure_devops_org_url`.. `telegram_otp_window_minutes`
//! group below) used to live in the Keychain's shared secrets blob purely to
//! keep their injection path uniform with real credentials, even though they
//! aren't sensitive — see the historical note in `keychain.rs`. `init` migrates
//! any such values it finds on first run, removes them from the Keychain, and
//! never touches the Keychain again for this purpose (`keychain_settings_migrated`).

use std::path::PathBuf;
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Manager};

use crate::keychain;

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
    /// Azure DevOps organization base URL for the PR dashboard; see
    /// `sidecar::build_command`.
    pub azure_devops_org_url: Option<String>,
    /// Atlassian Cloud site base URL for the Issues dashboard.
    pub jira_base_url: Option<String>,
    /// Atlassian account email paired with the JIRA API token (Keychain).
    pub jira_email: Option<String>,
    /// Google Cloud OAuth client id for the calendar integration. Desktop-app
    /// OAuth client ids aren't confidential — only the paired client secret is,
    /// which stays in the Keychain.
    pub google_client_id: Option<String>,
    /// Re-auth window, in minutes, for the Telegram bot's OTP gate. Only the
    /// window duration lives here — the chat-id allowlist itself stays in the
    /// Keychain (`keychain::SECRET_KEYS`), because OTP is off by default and
    /// the allowlist is then the bot's *only* access-control check; a plain
    /// file has no per-item authorization the way a Keychain entry does.
    pub telegram_otp_window_minutes: Option<u32>,
    /// Set once [`migrate_keychain_settings`] has run, so steady-state startup
    /// never re-reads the Keychain to check for values that can no longer be
    /// there — the whole point of the migration is one Keychain access, not
    /// one-that-happens-to-find-nothing-forever.
    keychain_settings_migrated: Option<bool>,
}

/// Keychain keys that used to carry the non-secret fields above. Kept only for
/// the one-time migration in [`migrate_keychain_settings`] — they are no
/// longer in `keychain::SECRET_KEYS`, so nothing can write them back.
const LEGACY_SETTING_KEYS: &[&str] = &[
    "azure_devops_org_url",
    "jira_base_url",
    "jira_email",
    "google_client_id",
    "telegram_otp_window_minutes",
];

/// Sets `field` to `value` unless it's already populated, reporting whether it
/// applied the change so the caller knows which Keychain keys to clear.
fn set_if_unset<T>(field: &mut Option<T>, value: T) -> bool {
    if field.is_some() {
        return false;
    }
    *field = Some(value);
    true
}

/// Copies any of `LEGACY_SETTING_KEYS` present in `root` into `settings`,
/// skipping a field that already has a value so a user's own edit is never
/// overwritten. Returns the keys that were migrated, for the caller to remove
/// from the Keychain root. Pure and free of I/O so the migration logic is
/// testable without a real Keychain.
fn apply_legacy_migration(settings: &mut Settings, root: &Value) -> Vec<&'static str> {
    let mut migrated = Vec::new();
    for &key in LEGACY_SETTING_KEYS {
        let Some(value) = keychain::secret_from_root(root, key) else {
            continue;
        };
        let applied = match key {
            "azure_devops_org_url" => set_if_unset(&mut settings.azure_devops_org_url, value),
            "jira_base_url" => set_if_unset(&mut settings.jira_base_url, value),
            "jira_email" => set_if_unset(&mut settings.jira_email, value),
            "google_client_id" => set_if_unset(&mut settings.google_client_id, value),
            "telegram_otp_window_minutes" => match value.parse::<u32>() {
                // 0 isn't valid (see `set_telegram_otp_window_minutes`); treat
                // it the same as malformed rather than migrating a value the
                // live setter would itself reject.
                Ok(0) | Err(_) => true,
                Ok(minutes) => set_if_unset(&mut settings.telegram_otp_window_minutes, minutes),
            },
            _ => unreachable!("LEGACY_SETTING_KEYS and this match must stay in lockstep"),
        };
        if applied {
            migrated.push(key);
        }
    }
    migrated
}

/// Runs the one-time migration: reads the Keychain's shared secrets item,
/// copies any legacy non-secret values into `state`, and removes them from the
/// Keychain. Skips the Keychain read entirely once `keychain_settings_migrated`
/// is set — otherwise every startup would cost a second access to the shared
/// item just to confirm there's nothing left to migrate, which is the same
/// "more than one prompt" problem this migration exists to close. The settings
/// file is saved (with the flag set, even if nothing was found to migrate)
/// before the Keychain is touched, so a disk failure leaves the values in
/// place — and the migration retried next launch — rather than losing them.
fn migrate_keychain_settings(state: &SettingsState) {
    if state.snapshot().keychain_settings_migrated == Some(true) {
        return;
    }
    let root = keychain::read_root();
    let mut settings = state.snapshot();
    let migrated = apply_legacy_migration(&mut settings, &root);
    settings.keychain_settings_migrated = Some(true);
    match state.settings.lock() {
        Ok(mut guard) => *guard = settings,
        Err(e) => {
            eprintln!("[settings] lock poisoned during Keychain migration: {e}");
            return;
        }
    }
    if let Err(e) = state.save() {
        eprintln!("[settings] failed to persist migrated Keychain settings: {e}");
        return;
    }
    if migrated.is_empty() {
        return;
    }
    let mut new_root = root;
    if let Some(obj) = new_root.as_object_mut() {
        for key in &migrated {
            obj.remove(*key);
        }
    }
    if let Err(e) = keychain::write_root(&new_root) {
        eprintln!(
            "[settings] migrated settings saved, but failed to clear them from the Keychain: {e}"
        );
    }
}

pub struct SettingsState {
    settings: Mutex<Settings>,
    path: PathBuf,
}

impl SettingsState {
    fn load(path: PathBuf) -> Self {
        let settings = Self::read_from_disk(&path);
        Self {
            settings: Mutex::new(settings),
            path,
        }
    }

    /// A malformed or missing file reads as defaults rather than failing —
    /// on startup that means a fresh install just gets the built-in defaults,
    /// and mid-run (see the setters below) it means a concurrent writer's
    /// truncated-but-not-yet-renamed file never gets read back half-written.
    fn read_from_disk(path: &std::path::Path) -> Settings {
        std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
            .unwrap_or_default()
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
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            // The file lives in a private (~/.yarvis, 0700) directory but carries
            // its own 0600 in case that directory is ever loosened or the file
            // copied elsewhere — it can hold a JIRA account email and similar.
            if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)) {
                eprintln!("[settings] failed to set {tmp:?} to 0600: {e}");
            }
        }
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
            // Re-read the shared file before merging in this one field, the
            // same read-before-write discipline `keychain.rs`'s nested modules
            // use for the Keychain item — `~/.yarvis/settings.json` is shared
            // across `dev:instance` copies too, so writing straight from this
            // process's in-memory snapshot would silently drop whatever a
            // longer-running instance saved after this one started.
            *settings = Self::read_from_disk(&self.path);
            settings.max_pty_sessions = value;
        }
        self.save()
    }

    /// Stores the agent's display name and launch command. Both fields are
    /// written on every call, so a `None` or blank value clears that field back
    /// to its built-in default rather than leaving the stored one in place.
    ///
    /// Control characters are rejected. The command is typed into an interactive
    /// shell as a single launch line, so a newline would submit whatever follows
    /// it as a second command — and 0x03/0x15 would do the same by way of the
    /// line editor, for the reasons `pty::is_unsafe_name_char` documents. This
    /// file is also hand-editable, so `pty` re-checks on read; rejecting here is
    /// what gives the user an error instead of silent mangling.
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
            *settings = Self::read_from_disk(&self.path);
            settings.agent_name = name;
            settings.agent_command = command;
        }
        self.save()
    }

    /// Stores a plain-text field, or clears it back to unset on a blank value.
    /// Shared by the integration settings below, none of which need more than
    /// trimming — unlike `agent_command`, none of these are typed into a shell.
    fn set_text_field(
        &self,
        value: Option<String>,
        field: fn(&mut Settings) -> &mut Option<String>,
    ) -> Result<(), String> {
        let value = non_blank(value);
        {
            let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
            *settings = Self::read_from_disk(&self.path);
            *field(&mut settings) = value;
        }
        self.save()
    }

    /// Stores the Telegram OTP re-auth window, or clears it back to the
    /// sidecar's default (`parseOtpWindowMinutes` in `config.ts`) with `None`.
    fn set_telegram_otp_window_minutes(&self, value: Option<u32>) -> Result<(), String> {
        if value == Some(0) {
            return Err("the OTP window must be at least 1 minute".to_string());
        }
        {
            let mut settings = self.settings.lock().map_err(|e| e.to_string())?;
            *settings = Self::read_from_disk(&self.path);
            settings.telegram_otp_window_minutes = value;
        }
        self.save()
    }
}

/// The trimmed value, or `None` when it is absent or blank — an emptied field in
/// the UI means "use the default", which is stored the same way as never having
/// set one. Applied on read as well as on write (see `pty::agent_command`) so a
/// hand-edited settings file can't yield an empty command either.
pub(crate) fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// `~/.yarvis`, created with private (0700) permissions on first run. Shared
/// with the sidecar's `~/.yarvis/agents` convention (`agents/catalog.ts`).
fn yarvis_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let home = app.path().home_dir().map_err(|e| e.to_string())?;
    let dir = home.join(".yarvis");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if let Err(e) = std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o700)) {
            eprintln!("[settings] failed to set {dir:?} to 0700: {e}");
        }
    }
    Ok(dir)
}

/// Moves a pre-existing `settings.json` from the old per-instance app-data
/// location to the new shared `~/.yarvis` one, so upgrading doesn't silently
/// reset a stored PTY cap or agent command. Only runs when nothing has been
/// written to the new location yet; best-effort, since a stale app-data file
/// left behind on failure is harmless.
fn migrate_legacy_app_data_file(app: &AppHandle, new_path: &PathBuf) {
    if new_path.exists() {
        return;
    }
    let Ok(old_dir) = app.path().app_data_dir() else {
        return;
    };
    let old_path = old_dir.join("settings.json");
    if old_path.exists() {
        if let Err(e) = std::fs::rename(&old_path, new_path) {
            eprintln!("[settings] failed to migrate {old_path:?} to {new_path:?}: {e}");
        }
    }
}

/// Loads persisted settings into managed state and runs the Keychain
/// migration. Call from `setup`.
pub fn init(app: &AppHandle) -> Result<(), String> {
    let dir = yarvis_dir(app)?;
    let path = dir.join("settings.json");
    migrate_legacy_app_data_file(app, &path);
    let state = SettingsState::load(path);
    migrate_keychain_settings(&state);
    app.manage(state);
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
    /// Default Telegram OTP re-auth window applied when unset; mirrors
    /// `DEFAULT_OTP_WINDOW_MINUTES` in `sidecar/src/config.ts`.
    default_telegram_otp_window_minutes: u32,
}

/// Mirrors `DEFAULT_OTP_WINDOW_MINUTES` in `sidecar/src/config.ts`.
const DEFAULT_TELEGRAM_OTP_WINDOW_MINUTES: u32 = 120;

impl From<Settings> for SettingsView {
    fn from(settings: Settings) -> Self {
        Self {
            settings,
            default_max_pty_sessions: crate::pty::DEFAULT_MAX_SESSIONS,
            max_configurable_pty_sessions: crate::pty::MAX_CONFIGURABLE_SESSIONS,
            default_agent_name: crate::pty::DEFAULT_AGENT_NAME,
            default_agent_command: crate::pty::DEFAULT_AGENT_COMMAND,
            agent_command_overridden_by_env: crate::pty::agent_command_env().is_some(),
            default_telegram_otp_window_minutes: DEFAULT_TELEGRAM_OTP_WINDOW_MINUTES,
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

/// Sets the Azure DevOps organization base URL for the PR dashboard, or clears
/// it on `None`/blank. Takes effect on the sidecar's next restart.
#[tauri::command]
pub fn set_azure_devops_org_url(
    state: tauri::State<'_, SettingsState>,
    value: Option<String>,
) -> Result<SettingsView, String> {
    state.set_text_field(value, |s| &mut s.azure_devops_org_url)?;
    Ok(state.snapshot().into())
}

/// Sets the JIRA Cloud site base URL for the Issues dashboard, or clears it on
/// `None`/blank. Takes effect on the sidecar's next restart.
#[tauri::command]
pub fn set_jira_base_url(
    state: tauri::State<'_, SettingsState>,
    value: Option<String>,
) -> Result<SettingsView, String> {
    state.set_text_field(value, |s| &mut s.jira_base_url)?;
    Ok(state.snapshot().into())
}

/// Sets the Atlassian account email paired with the JIRA API token, or clears
/// it on `None`/blank. Takes effect on the sidecar's next restart.
#[tauri::command]
pub fn set_jira_email(
    state: tauri::State<'_, SettingsState>,
    value: Option<String>,
) -> Result<SettingsView, String> {
    state.set_text_field(value, |s| &mut s.jira_email)?;
    Ok(state.snapshot().into())
}

/// Sets the Google Cloud OAuth client id for the calendar integration, or
/// clears it on `None`/blank. Takes effect on the sidecar's next restart.
#[tauri::command]
pub fn set_google_client_id(
    state: tauri::State<'_, SettingsState>,
    value: Option<String>,
) -> Result<SettingsView, String> {
    state.set_text_field(value, |s| &mut s.google_client_id)?;
    Ok(state.snapshot().into())
}

/// Sets the Telegram OTP re-auth window in minutes, or clears it back to the
/// sidecar's default with `None`. See `SettingsState::set_telegram_otp_window_minutes`.
#[tauri::command]
pub fn set_telegram_otp_window_minutes(
    state: tauri::State<'_, SettingsState>,
    value: Option<u32>,
) -> Result<SettingsView, String> {
    state.set_telegram_otp_window_minutes(value)?;
    Ok(state.snapshot().into())
}

#[cfg(test)]
mod tests {
    use super::{apply_legacy_migration, Settings, SettingsState, SettingsView};
    use serde_json::json;

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
        assert!(json["azureDevopsOrgUrl"].is_null());
        assert!(json["telegramOtpWindowMinutes"].is_null());
        assert_eq!(json["defaultTelegramOtpWindowMinutes"], 120);
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

    #[test]
    fn a_stored_integration_setting_survives_a_reload() {
        let store = temp_store("integration-round-trip");
        store
            .set_text_field(Some("https://dev.azure.com/acme".to_string()), |s| {
                &mut s.azure_devops_org_url
            })
            .unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(
            reloaded.snapshot().azure_devops_org_url.as_deref(),
            Some("https://dev.azure.com/acme")
        );
    }

    #[test]
    fn a_blank_integration_setting_clears_back_to_unset() {
        let store = temp_store("integration-blank");
        store
            .set_text_field(Some("https://dev.azure.com/acme".to_string()), |s| {
                &mut s.azure_devops_org_url
            })
            .unwrap();
        store
            .set_text_field(Some("   ".to_string()), |s| &mut s.azure_devops_org_url)
            .unwrap();

        assert_eq!(store.snapshot().azure_devops_org_url, None);
    }

    #[test]
    fn a_zero_otp_window_is_rejected_and_nothing_is_stored() {
        let store = temp_store("otp-window-zero");
        assert!(store.set_telegram_otp_window_minutes(Some(0)).is_err());
        assert_eq!(store.snapshot().telegram_otp_window_minutes, None);
    }

    #[test]
    fn a_stored_otp_window_survives_a_reload() {
        let store = temp_store("otp-window-round-trip");
        store.set_telegram_otp_window_minutes(Some(45)).unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().telegram_otp_window_minutes, Some(45));
    }

    #[test]
    fn legacy_keychain_values_are_migrated_into_settings() {
        let mut settings = Settings::default();
        let root = json!({
            "anthropic_api_key": "sk-ant-should-stay-in-keychain",
            "telegram_allowed_chat_ids": "123,456-should-stay-in-keychain",
            "azure_devops_org_url": "https://dev.azure.com/acme",
            "jira_base_url": "https://acme.atlassian.net",
            "jira_email": "dev@acme.com",
            "google_client_id": "abc.apps.googleusercontent.com",
            "telegram_otp_window_minutes": "45",
        });

        let migrated = apply_legacy_migration(&mut settings, &root);

        assert_eq!(
            settings.azure_devops_org_url.as_deref(),
            Some("https://dev.azure.com/acme")
        );
        assert_eq!(
            settings.jira_base_url.as_deref(),
            Some("https://acme.atlassian.net")
        );
        assert_eq!(settings.jira_email.as_deref(), Some("dev@acme.com"));
        assert_eq!(
            settings.google_client_id.as_deref(),
            Some("abc.apps.googleusercontent.com")
        );
        assert_eq!(settings.telegram_otp_window_minutes, Some(45));
        assert_eq!(migrated.len(), 5);
        assert!(!migrated.contains(&"anthropic_api_key"));
        // The chat-id allowlist is the bot's sole access-control check when
        // OTP is off, so it stays a Keychain-only secret — never migrated.
        assert!(!migrated.contains(&"telegram_allowed_chat_ids"));
    }

    #[test]
    fn migration_never_overwrites_an_existing_setting() {
        let mut settings = Settings {
            jira_base_url: Some("https://already-configured.atlassian.net".to_string()),
            ..Settings::default()
        };
        let root = json!({ "jira_base_url": "https://legacy.atlassian.net" });

        let migrated = apply_legacy_migration(&mut settings, &root);

        assert_eq!(
            settings.jira_base_url.as_deref(),
            Some("https://already-configured.atlassian.net")
        );
        assert!(migrated.is_empty());
    }

    #[test]
    fn migration_is_a_no_op_on_an_empty_keychain_root() {
        let mut settings = Settings::default();
        let migrated = apply_legacy_migration(&mut settings, &json!({}));
        assert!(migrated.is_empty());
        assert_eq!(settings.azure_devops_org_url, None);
    }

    #[test]
    fn a_malformed_otp_window_is_discarded_rather_than_retried_forever() {
        let mut settings = Settings::default();
        let root = json!({ "telegram_otp_window_minutes": "not-a-number" });

        let migrated = apply_legacy_migration(&mut settings, &root);

        // Nothing usable to store, but it's still reported as migrated so the
        // caller removes the unparseable value from the Keychain instead of
        // reading it again on every future launch.
        assert_eq!(settings.telegram_otp_window_minutes, None);
        assert_eq!(migrated, vec!["telegram_otp_window_minutes"]);
    }

    #[test]
    fn a_zero_otp_window_is_discarded_by_migration_like_the_live_setter_would_reject_it() {
        let mut settings = Settings::default();
        let root = json!({ "telegram_otp_window_minutes": "0" });

        let migrated = apply_legacy_migration(&mut settings, &root);

        assert_eq!(settings.telegram_otp_window_minutes, None);
        assert_eq!(migrated, vec!["telegram_otp_window_minutes"]);
    }

    #[test]
    fn the_migrated_flag_survives_a_reload_so_migration_never_re_runs() {
        let store = temp_store("migrated-flag-round-trip");
        {
            let mut settings = store.settings.lock().unwrap();
            settings.keychain_settings_migrated = Some(true);
        }
        store.save().unwrap();

        let reloaded = SettingsState::load(store.path.clone());
        assert_eq!(reloaded.snapshot().keychain_settings_migrated, Some(true));
    }
}
