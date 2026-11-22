//! User-editable settings the server owns.
//!
//! Non-secret preferences, persisted in `~/.yarvis/settings.json` (or
//! `YARVIS_SETTINGS_PATH`, which the sidecar honors too) and written with an
//! atomic rename. Secrets belong in the secrets blob ([`crate::secret_blob`]);
//! the fields here are values the server itself reads, enforces, or injects
//! into the sidecar's environment, so a client can change them without the
//! server having to ask the sidecar.
//!
//! The server owns only these fields, not the file: the sidecar keeps its own
//! top-level sections in the same document (`sidecar/src/settings/store.ts`),
//! so a save writes the server's fields over the document on disk and carries
//! every other key across unchanged.
//!
//! The file can be shared with a desktop app running beside the server, so
//! nothing is cached: every read goes to disk, and every setter re-reads the
//! file before merging in its one field rather than writing from a snapshot.
//! That narrows, but doesn't close, the window. There is no file lock, so two
//! processes saving at nearly the same moment can still clobber each other.
//!
//! Older desktop builds kept a handful of these fields (`azure_devops_org_url`
//! to `telegram_otp_window_minutes`) in the Keychain's secrets blob. [`SettingsStore::migrate_keychain_settings`]
//! moves any it finds there once, then never touches the Keychain for this
//! again (`keychain_settings_migrated`).

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::agent_policy::{self, non_blank};
use crate::config::SecretBackendKind;
use crate::harness::{self, AgentHarness};
use crate::secret_blob::{self, SecretBlob, Store, WriteGuard};
use crate::secret_store::onepassword::{self, ItemRef};

/// The persisted settings document. Every field is optional and absent means
/// "use the built-in default", so a file written by an older build stays
/// readable and an unset field never has to encode a default that then drifts
/// from the one in code.
#[derive(Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Settings {
    /// Cap on live PTY sessions; see [`agent_policy::resolve_max_sessions`].
    pub max_pty_sessions: Option<usize>,
    /// Display name for a workspace's agent tab.
    pub agent_name: Option<String>,
    /// Base command a workspace's agent session is launched from; see
    /// [`agent_policy::resolve_agent_command`].
    pub agent_command: Option<String>,
    /// Agent harnesses beyond the built-in one; see [`crate::harness`].
    #[serde(default, deserialize_with = "harness::deserialize_lenient")]
    pub agent_harnesses: Option<Vec<AgentHarness>>,
    /// Id of the harness a launch gets when it names none. Unset means the
    /// built-in one.
    #[serde(default, deserialize_with = "harness::deserialize_default_lenient")]
    pub default_agent_harness: Option<String>,
    /// Azure DevOps organization base URL for the PR dashboard.
    pub azure_devops_org_url: Option<String>,
    /// Atlassian Cloud site base URL for the Issues dashboard.
    pub jira_base_url: Option<String>,
    /// Atlassian account email paired with the JIRA API token.
    pub jira_email: Option<String>,
    /// Google Cloud OAuth client id for the calendar integration. Desktop-app
    /// OAuth client ids aren't confidential; only the paired client secret is,
    /// which stays in the secrets blob.
    pub google_client_id: Option<String>,
    /// Re-auth window, in minutes, for the Telegram bot's OTP gate. Only the
    /// window lives here. The chat-id allowlist stays in the secrets blob,
    /// because OTP is off by default and the allowlist is then the bot's only
    /// access-control check.
    pub telegram_otp_window_minutes: Option<u32>,
    /// Which store the desktop app reads the secrets blob from. The server
    /// takes its backend from `server.toml` instead, and only writes this so a
    /// desktop app sharing the file agrees with it.
    pub secret_backend: Option<String>,
    /// 1Password vault holding the secrets item, read while the backend is
    /// 1Password.
    pub one_password_vault: Option<String>,
    /// Title of the 1Password item holding the secrets blob.
    pub one_password_item: Option<String>,
    /// The UI's colour theme. Only the UI reads it, and it maps a name it
    /// doesn't know to its default (`lib/theme.ts`), so it's stored as text.
    pub color_theme: Option<String>,
    /// Font size every terminal renders at. The UI clamps it on read
    /// (`lib/terminalFont.ts`), so a hand edit can't push it out of bounds.
    pub terminal_font_size: Option<u32>,
    /// Whether the top bar animates while the attention bell has something
    /// pending. Unset means on; only `false` turns it off.
    pub attention_animation: Option<bool>,
    /// Slash commands, beyond [`agent_policy::DEFAULT_ALLOWED_SLASH_COMMANDS`],
    /// that the sidecar may send to a workspace's agent session. Names only,
    /// without the leading `/`. Kept here rather than in the sidecar's sections
    /// because no sidecar route or tool writes these, so the assistant can't
    /// widen its own allowlist.
    pub allowed_slash_commands: Option<Vec<String>>,
    /// Whether the assistant may message workspace sessions over a Claude Code
    /// channel (`sidecar/src/channel`). Experimental, so unset means off. Kept
    /// here for the same reason as `allowed_slash_commands`.
    pub channel_messaging: Option<bool>,
    /// Set once the Keychain migration has run, so steady-state startup never
    /// re-reads the Keychain to look for values that can no longer be there.
    keychain_settings_migrated: Option<bool>,
}

impl Settings {
    /// Whether `secretBackend` names 1Password. Anything else, including
    /// unset or a value this build doesn't know, means the Keychain.
    pub fn selects_onepassword(&self) -> bool {
        self.secret_backend.as_deref() == Some("onepassword")
    }

    /// The 1Password item `onePasswordVault`/`onePasswordItem` name.
    pub fn onepassword_item(&self) -> Result<ItemRef, String> {
        ItemRef::new(
            self.one_password_vault.as_deref().unwrap_or_default(),
            self.one_password_item.as_deref().unwrap_or_default(),
        )
    }
}

/// A store [`SettingsStore::set_secret_backend`] can move between.
#[derive(PartialEq)]
enum Target {
    Keychain,
    OnePassword(ItemRef),
}

impl Target {
    fn store(&self) -> Store {
        match self {
            Self::Keychain => Store::keychain(),
            Self::OnePassword(item) => Store::onepassword(item.clone()),
        }
    }
}

/// Keychain keys older builds used for the non-secret fields above. Kept only for
/// the one-time migration; they are not in [`secret_blob::SECRET_KEYS`], so
/// nothing can write them back.
const LEGACY_SETTING_KEYS: &[&str] = &[
    "azure_devops_org_url",
    "jira_base_url",
    "jira_email",
    "google_client_id",
    "telegram_otp_window_minutes",
];

/// Mirrors `DEFAULT_OTP_WINDOW_MINUTES` in `sidecar/src/config.ts`.
const DEFAULT_TELEGRAM_OTP_WINDOW_MINUTES: u32 = 120;

/// The settings file, and the in-process lock that serializes its setters.
#[derive(Clone)]
pub struct SettingsStore {
    path: Arc<PathBuf>,
    write: Arc<Mutex<()>>,
}

impl SettingsStore {
    /// A store over `path`. Does no I/O: the file is read on every access.
    pub fn new(path: PathBuf) -> Self {
        Self {
            path: Arc::new(path),
            write: Arc::new(Mutex::new(())),
        }
    }

    /// `YARVIS_SETTINGS_PATH`, else `~/.yarvis/settings.json`. The sidecar
    /// resolves the same way (`sidecar/src/settings/store.ts`), and it inherits
    /// the server's environment, so both read the same file. So does the
    /// desktop app's move of a pre-#277 file (`src-tauri/src/legacy_settings.rs`).
    pub fn default_path() -> PathBuf {
        if let Some(path) = std::env::var_os("YARVIS_SETTINGS_PATH").filter(|p| !p.is_empty()) {
            return PathBuf::from(path);
        }
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."))
            .join(".yarvis")
            .join("settings.json")
    }

    /// Creates the settings file's directory with private (0700) permissions.
    /// Called once at startup; a failure is logged, and the first save reports
    /// its own error.
    pub fn ensure_dir(&self) {
        let Some(dir) = self.path.parent() else {
            return;
        };
        if let Err(e) = std::fs::create_dir_all(dir) {
            tracing::warn!("couldn't create {}: {e}", dir.display());
            return;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            if let Err(e) = std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700)) {
                tracing::warn!("couldn't set {} to 0700: {e}", dir.display());
            }
        }
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Where the secrets write lock lives: beside `settings.json`, which every
    /// process sharing the secrets item also shares.
    pub fn secrets_lock_path(&self) -> PathBuf {
        self.path.with_file_name("secrets.lock")
    }

    /// The settings as they are on disk. A malformed or missing file reads
    /// as defaults rather than failing: a fresh install gets the built-in
    /// defaults, and a concurrent writer's temp file is never read half-written
    /// because it only replaces the file by rename.
    pub fn snapshot(&self) -> Settings {
        read_from_disk(&self.path)
    }

    /// What clients get back: the stored settings plus the defaults an unset
    /// field falls back to.
    pub fn view(&self) -> SettingsView {
        self.snapshot().into()
    }

    /// Re-reads the file, lets `edit` change it, and saves, under the
    /// in-process write lock. `edit` runs only after validation by the caller.
    fn update(&self, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let _guard = self.write.lock().map_err(|e| e.to_string())?;
        let mut settings = read_from_disk(&self.path);
        edit(&mut settings);
        save(&self.path, &settings)
    }

    /// Stores the live-PTY-session cap, or clears it back to the default with
    /// `None`. Rejects a value outside what the session launcher enforces rather
    /// than storing one and echoing back a cap that isn't the one in force.
    pub fn set_max_pty_sessions(&self, value: Option<usize>) -> Result<(), String> {
        match value {
            Some(0) => return Err("the session cap must be at least 1".to_string()),
            Some(n) if n > agent_policy::MAX_CONFIGURABLE_SESSIONS => {
                return Err(format!(
                    "the session cap can be at most {}",
                    agent_policy::MAX_CONFIGURABLE_SESSIONS
                ));
            }
            _ => {}
        }
        self.update(|s| s.max_pty_sessions = value)
    }

    /// Stores the agent's display name and launch command. Both are written on
    /// every call, so a `None` or blank value clears that field back to its
    /// default.
    ///
    /// Control characters are rejected. The command is typed into an
    /// interactive shell as a single launch line, so a newline would submit
    /// whatever follows it as a second command, and 0x03/0x15 would do the
    /// same through the line editor. The file is hand-editable, so the
    /// session launcher re-checks on read
    /// ([`agent_policy::resolve_agent_command`]); rejecting here gives the user an error instead
    /// of silent mangling.
    pub fn set_agent(&self, name: Option<String>, command: Option<String>) -> Result<(), String> {
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
        self.update(|s| {
            s.agent_name = name;
            s.agent_command = command;
        })
    }

    /// Replaces the stored harness list and default. Rejected as a whole when
    /// any entry is invalid (see [`harness::validate`]), so a save never keeps
    /// half of what the user submitted. Clears the stored values of any secret
    /// variable the save drops, and saves nothing if that fails.
    pub fn set_agent_harnesses(
        &self,
        secrets: &SecretBlob,
        harnesses: Vec<AgentHarness>,
        default_id: Option<String>,
    ) -> Result<(), String> {
        // The secrets lock is held from reading the old list until the new one
        // is saved. `set_agent_harness_secret` checks the list under the same
        // lock, so it can't store a value for a variable this save drops.
        // Validated first, so a bad submission isn't held up behind another
        // save.
        harness::validate(&harnesses, non_blank(default_id.clone()).as_deref())?;
        let guard = secrets.lock_for_write()?;
        self.set_agent_harnesses_in(&guard, &secrets.active()?, harnesses, default_id)
    }

    /// [`Self::set_agent_harnesses`] against `store`, under a lock the caller holds.
    fn set_agent_harnesses_in(
        &self,
        guard: &WriteGuard,
        store: &Store,
        harnesses: Vec<AgentHarness>,
        default_id: Option<String>,
    ) -> Result<(), String> {
        let default_id = non_blank(default_id);
        harness::validate(&harnesses, default_id.as_deref())?;
        let before = self.snapshot().agent_harnesses.unwrap_or_default();
        let dropped = harness::dropped_secrets(&before, &harnesses);
        // Cleared before the list is saved: once it no longer declares them, no
        // later save would see them as dropped, and a harness reusing the id
        // and variable would inherit a key meant for the old one. Only when
        // something was dropped, so an ordinary save never prompts.
        if !dropped.is_empty() {
            secret_blob::update_subtree_locked(
                guard,
                store,
                harness::SECRET_ENV_SUBTREE,
                |subtree| Ok(harness::prune_secrets(subtree, &dropped)),
            )
            .map_err(|e| {
                format!("the removed secret values could not be cleared, so nothing was saved: {e}")
            })?;
        }
        self.update(|s| {
            s.agent_harnesses = (!harnesses.is_empty()).then_some(harnesses);
            s.default_agent_harness = default_id.filter(|id| id != harness::BUILTIN_HARNESS_ID);
        })
    }

    /// Which declared harness secrets are stored, in one secret-store read.
    /// Values are never returned: clients write secrets and never read them.
    pub fn list_agent_harness_secret_status(
        &self,
        secrets: &SecretBlob,
    ) -> Result<Vec<HarnessSecretStatus>, String> {
        let harnesses = self.snapshot().agent_harnesses.unwrap_or_default();
        if harnesses.iter().all(|h| h.secret_env.is_empty()) {
            return Ok(Vec::new());
        }
        let root = secrets.read_root()?;
        let stored = root.get(harness::SECRET_ENV_SUBTREE);
        Ok(harnesses
            .iter()
            .flat_map(|harness| {
                harness
                    .secret_env
                    .iter()
                    .map(move |key| HarnessSecretStatus {
                        harness_id: harness.id.clone(),
                        key: key.clone(),
                        present: stored
                            .and_then(|s| s.get(&harness.id))
                            .and_then(|values| values.get(key))
                            .and_then(Value::as_str)
                            .is_some_and(|v| !v.is_empty()),
                    })
            })
            .collect())
    }

    /// Stores, or with `None` removes, one secret variable's value for a
    /// harness. Only a variable the saved harness declares in `secretEnv` can
    /// be written, so a client can't use this to put arbitrary data in the
    /// secret store. Removing works for any name, so a variable dropped from a
    /// harness can still have its old value cleared.
    pub fn set_agent_harness_secret(
        &self,
        secrets: &SecretBlob,
        harness_id: &str,
        key: &str,
        value: Option<String>,
    ) -> Result<(), String> {
        secrets.update_subtree(harness::SECRET_ENV_SUBTREE, |subtree| {
            // Checked under the secrets lock, against the file: a harness save
            // that drops this variable prunes under the same lock, so the two
            // can't interleave and leave a value behind.
            let declared = || {
                self.snapshot()
                    .agent_harnesses
                    .unwrap_or_default()
                    .iter()
                    .any(|h| h.id == harness_id && h.secret_env.iter().any(|k| k == key))
            };
            write_harness_secret(subtree, harness_id, key, value, declared)
        })
    }

    /// Stores the user's extra allowed slash commands, or clears them with an
    /// empty list. Names are stored lower-case without a leading `/`, and one
    /// that isn't shaped like a command name is rejected rather than dropped,
    /// so the user sees why it didn't save.
    pub fn set_allowed_slash_commands(&self, commands: Vec<String>) -> Result<(), String> {
        let mut names: Vec<String> = Vec::new();
        for raw in commands {
            let name = agent_policy::normalize_slash_command_name(&raw);
            if name.is_empty() {
                continue;
            }
            if !agent_policy::is_valid_slash_command_name(&name) {
                return Err(format!("\"{}\" is not a slash command name", raw.trim()));
            }
            if agent_policy::is_refused_slash_command(&name) {
                return Err(format!(
                    "/{name} changes what the session may do, so it can't be allowed"
                ));
            }
            if !names.contains(&name) {
                names.push(name);
            }
        }
        self.update(|s| s.allowed_slash_commands = (!names.is_empty()).then_some(names))
    }

    /// Stores a plain-text field, or clears it back to unset on a blank value.
    /// Shared by the integration and appearance settings, none of which need
    /// more than trimming, since none is typed into a shell.
    pub fn set_text_field(&self, field: TextField, value: Option<String>) -> Result<(), String> {
        let value = non_blank(value);
        self.update(|s| *field.slot(s) = value)
    }

    /// Stores the Telegram OTP re-auth window, or clears it back to the
    /// sidecar's default with `None`.
    pub fn set_telegram_otp_window_minutes(&self, value: Option<u32>) -> Result<(), String> {
        if value == Some(0) {
            return Err("the OTP window must be at least 1 minute".to_string());
        }
        self.update(|s| s.telegram_otp_window_minutes = value)
    }

    /// Turns channel messaging on, or clears it back to the default (off).
    pub fn set_channel_messaging(&self, enabled: bool) -> Result<(), String> {
        self.update(|s| s.channel_messaging = enabled.then_some(true))
    }

    /// Stores whether the top bar's attention animation runs, or clears it
    /// back to the default (on) with `None`.
    pub fn set_attention_animation(&self, value: Option<bool>) -> Result<(), String> {
        self.update(|s| s.attention_animation = value)
    }

    /// Stores the terminal font size, or clears it back to the default with
    /// `None`. Zero can only be a bug, never a choice.
    pub fn set_terminal_font_size(&self, value: Option<u32>) -> Result<(), String> {
        if value == Some(0) {
            return Err("the terminal font size must be at least 1".to_string());
        }
        self.update(|s| s.terminal_font_size = value)
    }

    /// Points the server at a different secret store, carrying the existing
    /// secrets across.
    ///
    /// When `server.toml` names a backend, that file decides the kind of
    /// store, so `backend` must name it. A switch between kinds is an edit to
    /// that file and a restart, and what can change here is which 1Password
    /// item a 1Password server reads. The first item such a server is given is
    /// filled from the Keychain, where the desktop app kept the secrets. When
    /// `server.toml` names none, `settings.json` decides, and this switches
    /// between the Keychain and 1Password the way the desktop app does.
    ///
    /// The order is the whole of the safety: reach the new store, copy the
    /// blob into it, and only then persist the selection. Reversed, a store
    /// that turns out to be unreachable leaves the server pointing at nothing.
    /// The old copy is left in place, so a user who mistypes a vault has
    /// somewhere to switch back to.
    pub fn set_secret_backend(
        &self,
        secrets: &SecretBlob,
        configured: Option<SecretBackendKind>,
        backend: &str,
        vault: Option<String>,
        item: Option<String>,
    ) -> Result<Copied, BackendSwitchError> {
        self.set_secret_backend_with(
            secrets,
            configured,
            backend,
            vault,
            item,
            Target::store,
            onepassword::probe,
        )
    }

    /// [`Self::set_secret_backend`] with the stores it opens and the 1Password
    /// probe passed in, so tests can run a switch that copies without the
    /// Keychain or `op`.
    #[allow(clippy::too_many_arguments)]
    fn set_secret_backend_with(
        &self,
        secrets: &SecretBlob,
        configured: Option<SecretBackendKind>,
        backend: &str,
        vault: Option<String>,
        item: Option<String>,
        open: impl Fn(&Target) -> Store,
        probe: impl Fn(&ItemRef) -> Result<(), String>,
    ) -> Result<Copied, BackendSwitchError> {
        let requested = match backend {
            "keychain" => SecretBackendKind::Keychain,
            "onepassword" => SecretBackendKind::OnePassword,
            "vault" => SecretBackendKind::Vault,
            other => {
                return Err(BackendSwitchError::Invalid(format!(
                    "unknown secret backend: {other}"
                )));
            }
        };
        match configured {
            Some(kind) if kind != requested => return Err(BackendSwitchError::NotConfigured),
            Some(SecretBackendKind::Keychain | SecretBackendKind::Vault) => {
                return Ok(Copied::Unchanged);
            }
            None if requested == SecretBackendKind::Vault => {
                return Err(BackendSwitchError::NotConfigured);
            }
            _ => {}
        }
        let vault = non_blank(vault);
        let item = non_blank(item);
        let target = match requested {
            SecretBackendKind::OnePassword => Target::OnePassword(
                ItemRef::new(
                    vault.as_deref().unwrap_or_default(),
                    item.as_deref().unwrap_or_default(),
                )
                .map_err(BackendSwitchError::Invalid)?,
            ),
            _ => Target::Keychain,
        };
        // Held until the new selection is saved: a write that landed in the
        // old store after the copy would be left behind there.
        let guard = secrets
            .lock_for_write()
            .map_err(BackendSwitchError::Failed)?;
        let settings = self.snapshot();
        // A 1Password server reads the item settings name whatever
        // `secretBackend` says; otherwise `secretBackend` decides. With no
        // usable item, the store being left is the Keychain.
        let reads_item = configured.is_some() || settings.selects_onepassword();
        let current = match settings.onepassword_item() {
            Ok(item) if reads_item => Target::OnePassword(item),
            _ => Target::Keychain,
        };
        // Re-saving the same selection is not a switch: reporting it as a copy
        // that found nothing would tell a user with a full store it was empty.
        let copied = if current == target {
            Copied::Unchanged
        } else {
            if let Target::OnePassword(item) = &target {
                probe(item).map_err(BackendSwitchError::Failed)?;
            }
            copy_secrets(&guard, &open(&current), &open(&target))
                .map_err(BackendSwitchError::Failed)?
        };
        self.update(|s| {
            s.secret_backend =
                matches!(target, Target::OnePassword(_)).then(|| "onepassword".into());
            // Kept when switching back to the Keychain, so returning to
            // 1Password doesn't mean retyping the vault and item.
            if vault.is_some() {
                s.one_password_vault = vault;
            }
            if item.is_some() {
                s.one_password_item = item;
            }
        })
        .map_err(BackendSwitchError::Failed)?;
        Ok(copied)
    }

    /// The one-time move of legacy non-secret values out of the Keychain.
    /// Pinned to the Keychain rather than the configured store: it is about
    /// values a past build wrote there. Skips the Keychain entirely once the
    /// flag is set, so steady-state startup costs no Keychain access. The
    /// settings file is saved (with the flag set, even if nothing was found)
    /// before the Keychain is touched, so a disk failure leaves the values in
    /// place and the migration retried next start, rather than losing them.
    pub fn migrate_keychain_settings(&self, secrets: &SecretBlob, keychain: &Store) {
        if self.snapshot().keychain_settings_migrated == Some(true) {
            return;
        }
        let guard = match secrets.lock_for_write() {
            Ok(guard) => guard,
            Err(e) => {
                tracing::warn!("skipping the Keychain settings migration: {e}");
                return;
            }
        };
        let root = match secret_blob::read_root_from(keychain) {
            Ok(root) => root,
            Err(e) => {
                tracing::warn!("skipping the Keychain settings migration: {e}");
                return;
            }
        };
        let mut migrated = Vec::new();
        if let Err(e) = self.update(|s| {
            migrated = apply_legacy_migration(s, &root);
            s.keychain_settings_migrated = Some(true);
        }) {
            tracing::warn!("couldn't save the settings migrated from the Keychain: {e}");
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
        if let Err(e) = secret_blob::write_root_to(&guard, keychain, &new_root) {
            tracing::warn!(
                "migrated settings saved, but couldn't clear them from the Keychain: {e}"
            );
        }
    }
}

/// The plain-text settings [`SettingsStore::set_text_field`] can write.
#[derive(Clone, Copy, Debug)]
pub enum TextField {
    AzureDevopsOrgUrl,
    JiraBaseUrl,
    JiraEmail,
    GoogleClientId,
    ColorTheme,
}

impl TextField {
    fn slot(self, s: &mut Settings) -> &mut Option<String> {
        match self {
            Self::AzureDevopsOrgUrl => &mut s.azure_devops_org_url,
            Self::JiraBaseUrl => &mut s.jira_base_url,
            Self::JiraEmail => &mut s.jira_email,
            Self::GoogleClientId => &mut s.google_client_id,
            Self::ColorTheme => &mut s.color_theme,
        }
    }
}

/// Why a backend switch was refused.
#[derive(Debug)]
pub enum BackendSwitchError {
    /// The request asked for a kind other than the one `server.toml` names.
    NotConfigured,
    /// The request itself is malformed.
    Invalid(String),
    /// The new item couldn't be reached, read or written, or the selection
    /// couldn't be saved.
    Failed(String),
}

impl std::fmt::Display for BackendSwitchError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotConfigured => f.write_str(
                "the secret backend is set in server.toml ([secrets] backend); change it there and restart the server",
            ),
            Self::Invalid(e) | Self::Failed(e) => f.write_str(e),
        }
    }
}

fn read_from_disk(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Settings>(&s).ok())
        .unwrap_or_default()
}

/// The whole document, sidecar sections included. A file that isn't a JSON
/// object reads as empty, so a save replaces it.
fn read_document(path: &Path) -> serde_json::Map<String, Value> {
    match std::fs::read_to_string(path)
        .ok()
        .and_then(|s| serde_json::from_str::<Value>(&s).ok())
    {
        Some(Value::Object(document)) => document,
        _ => serde_json::Map::new(),
    }
}

/// Persists `settings`, reporting failure to the caller: every write is one
/// the user asked for and is told about.
///
/// The sidecar's sections aren't modeled by [`Settings`], so the save overlays
/// the server's fields onto the document on disk rather than replacing it.
/// Every server field is written, `None` as `null`, so clearing one overwrites
/// the value on disk instead of leaving it behind.
fn save(path: &Path, settings: &Settings) -> Result<(), String> {
    let Value::Object(fields) = serde_json::to_value(settings).map_err(|e| e.to_string())? else {
        return Err("settings did not serialize to an object".to_string());
    };
    let mut document = read_document(path);
    document.extend(fields);
    let json = serde_json::to_string_pretty(&document).map_err(|e| e.to_string())?;
    // Atomic write: a crash mid-write can't leave settings.json truncated.
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| e.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        // The directory is 0700, but the file carries its own 0600 in case it
        // is ever copied elsewhere; it can hold a JIRA account email.
        if let Err(e) = std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600)) {
            tracing::warn!("couldn't set {} to 0600: {e}", tmp.display());
        }
    }
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

/// Sets `field` to `value` unless it's already populated, reporting whether it
/// applied the change so the caller knows which Keychain keys to clear.
fn set_if_unset<T>(field: &mut Option<T>, value: T) -> bool {
    if field.is_some() {
        return false;
    }
    *field = Some(value);
    true
}

/// Copies any of [`LEGACY_SETTING_KEYS`] present in `root` into `settings`,
/// never overwriting a field the user already set. Returns the keys to remove
/// from the Keychain.
fn apply_legacy_migration(settings: &mut Settings, root: &Value) -> Vec<&'static str> {
    let mut migrated = Vec::new();
    for &key in LEGACY_SETTING_KEYS {
        let Some(value) = secret_blob::secret_from_root(root, key) else {
            continue;
        };
        let applied = match key {
            "azure_devops_org_url" => set_if_unset(&mut settings.azure_devops_org_url, value),
            "jira_base_url" => set_if_unset(&mut settings.jira_base_url, value),
            "jira_email" => set_if_unset(&mut settings.jira_email, value),
            "google_client_id" => set_if_unset(&mut settings.google_client_id, value),
            "telegram_otp_window_minutes" => match value.parse::<u32>() {
                // 0 isn't valid; treat it as malformed rather than migrating a
                // value the live setter would reject. Either way it is removed
                // so it isn't read again on every start.
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

/// What a backend switch did with the secrets, so the caller can say so.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum Copied {
    /// The selection was already what was asked for, so nothing moved.
    Unchanged,
    /// The secrets were carried into the new store.
    Secrets,
    /// The old store held nothing to carry.
    NothingToCopy,
    /// The new store already held secrets and was left exactly as it was.
    TargetAlreadyHadSecrets,
}

/// Copies the secrets blob from `from` into `to`, unless `to` is already
/// occupied: its contents are something the user put there, and overwriting
/// them would lose whatever exists only in that copy.
///
/// Occupancy is judged on the *raw* stored text: unparseable text reads as an
/// empty object, so a 1Password note the user wrote by hand would otherwise
/// look empty and be overwritten.
fn copy_secrets(guard: &WriteGuard, from: &Store, to: &Store) -> Result<Copied, String> {
    let occupied = to.read_raw()?.is_some_and(|raw| !raw.trim().is_empty());
    if occupied {
        return Ok(Copied::TargetAlreadyHadSecrets);
    }
    let source = secret_blob::read_root_from(from)?;
    if source.as_object().is_none_or(|o| o.is_empty()) {
        return Ok(Copied::NothingToCopy);
    }
    secret_blob::write_root_to(guard, to, &source)?;
    Ok(Copied::Secrets)
}

/// The edit [`SettingsStore::set_agent_harness_secret`] makes to the
/// harness-secrets subtree. `declared` is called only for a non-empty value.
/// Returns whether anything changed.
fn write_harness_secret(
    subtree: &mut Value,
    harness_id: &str,
    key: &str,
    value: Option<String>,
    declared: impl FnOnce() -> bool,
) -> Result<bool, String> {
    let obj = subtree
        .as_object_mut()
        .expect("update_subtree passes an object");
    match value.filter(|v| !v.is_empty()) {
        Some(value) => {
            if !declared() {
                return Err(format!(
                    "harness \"{harness_id}\" declares no secret variable {key}; save the harness first"
                ));
            }
            let values = obj
                .entry(harness_id.to_string())
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if !values.is_object() {
                *values = Value::Object(serde_json::Map::new());
            }
            values
                .as_object_mut()
                .expect("made an object above")
                .insert(key.to_string(), Value::String(value));
            Ok(true)
        }
        None => {
            let Some(values) = obj.get_mut(harness_id).and_then(Value::as_object_mut) else {
                return Ok(false);
            };
            let removed = values.remove(key).is_some();
            if values.is_empty() {
                obj.remove(harness_id);
            }
            Ok(removed)
        }
    }
}

/// Whether each secret variable a harness declares has a value stored.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSecretStatus {
    harness_id: String,
    key: String,
    present: bool,
}

/// The stored settings plus the defaults an unset field falls back to, so the
/// UI can show what "unset" means without repeating constants that then drift
/// from the ones the server enforces.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    #[serde(flatten)]
    settings: Settings,
    default_max_pty_sessions: usize,
    max_configurable_pty_sessions: usize,
    default_agent_name: &'static str,
    default_agent_command: &'static str,
    /// True while the agent-command env override is set. It outranks the
    /// stored command, so the UI says which one is in force.
    agent_command_overridden_by_env: bool,
    default_telegram_otp_window_minutes: u32,
    default_allowed_slash_commands: &'static [&'static str],
}

impl From<Settings> for SettingsView {
    fn from(settings: Settings) -> Self {
        Self {
            settings,
            default_max_pty_sessions: agent_policy::DEFAULT_MAX_SESSIONS,
            max_configurable_pty_sessions: agent_policy::MAX_CONFIGURABLE_SESSIONS,
            default_agent_name: agent_policy::DEFAULT_AGENT_NAME,
            default_agent_command: agent_policy::DEFAULT_AGENT_COMMAND,
            agent_command_overridden_by_env: agent_policy::agent_command_env().is_some(),
            default_telegram_otp_window_minutes: DEFAULT_TELEGRAM_OTP_WINDOW_MINUTES,
            default_allowed_slash_commands: agent_policy::DEFAULT_ALLOWED_SLASH_COMMANDS,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::harness::HarnessKind;
    use crate::secret_blob::tests::memory;
    use crate::secret_store::memory::MemoryBackend;
    use serde_json::json;

    fn temp_store() -> (tempfile::TempDir, SettingsStore) {
        let dir = tempfile::tempdir().unwrap();
        let store = SettingsStore::new(dir.path().join("settings.json"));
        (dir, store)
    }

    fn read_document(store: &SettingsStore) -> Value {
        serde_json::from_str(&std::fs::read_to_string(store.path()).unwrap()).unwrap()
    }

    #[test]
    fn the_secrets_lock_sits_beside_the_settings_file() {
        let store = SettingsStore::new("/home/me/.yarvis/settings.json".into());
        assert_eq!(
            store.secrets_lock_path(),
            Path::new("/home/me/.yarvis/secrets.lock")
        );
    }

    #[test]
    fn a_stored_cap_survives_and_clearing_it_does_too() {
        let (_dir, store) = temp_store();
        store.set_max_pty_sessions(Some(120)).unwrap();
        assert_eq!(store.snapshot().max_pty_sessions, Some(120));
        store.set_max_pty_sessions(None).unwrap();
        assert_eq!(store.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn a_malformed_file_reads_as_defaults() {
        let (_dir, store) = temp_store();
        std::fs::write(store.path(), "not json").unwrap();
        assert_eq!(store.snapshot().max_pty_sessions, None);
    }

    #[test]
    fn a_cap_out_of_range_is_rejected_and_nothing_is_stored() {
        let (_dir, store) = temp_store();
        assert!(store.set_max_pty_sessions(Some(0)).is_err());
        assert!(
            store
                .set_max_pty_sessions(Some(agent_policy::MAX_CONFIGURABLE_SESSIONS + 1))
                .is_err()
        );
        assert!(!store.path().exists());
        store
            .set_max_pty_sessions(Some(agent_policy::MAX_CONFIGURABLE_SESSIONS))
            .unwrap();
    }

    /// A write from another process between two of this one's saves must
    /// survive, since nothing is cached.
    #[test]
    fn a_setter_keeps_what_another_process_wrote_since() {
        let (_dir, store) = temp_store();
        store.set_max_pty_sessions(Some(5)).unwrap();
        std::fs::write(
            store.path(),
            json!({ "maxPtySessions": 5, "jiraEmail": "me@example.com" }).to_string(),
        )
        .unwrap();
        store.set_terminal_font_size(Some(14)).unwrap();
        let doc = read_document(&store);
        assert_eq!(doc["jiraEmail"], "me@example.com");
        assert_eq!(doc["terminalFontSize"], 14);
    }

    #[test]
    fn the_view_carries_the_keys_the_frontend_reads() {
        let json = serde_json::to_value(SettingsView::from(Settings::default())).unwrap();
        assert!(json["maxPtySessions"].is_null());
        assert_eq!(
            json["defaultMaxPtySessions"],
            agent_policy::DEFAULT_MAX_SESSIONS
        );
        assert_eq!(
            json["maxConfigurablePtySessions"],
            agent_policy::MAX_CONFIGURABLE_SESSIONS
        );
        assert_eq!(json["defaultAgentName"], agent_policy::DEFAULT_AGENT_NAME);
        assert_eq!(
            json["defaultAgentCommand"],
            agent_policy::DEFAULT_AGENT_COMMAND
        );
        assert!(json["agentCommandOverriddenByEnv"].is_boolean());
        assert_eq!(json["defaultTelegramOtpWindowMinutes"], 120);
        for key in [
            "agentName",
            "agentCommand",
            "azureDevopsOrgUrl",
            "telegramOtpWindowMinutes",
            "secretBackend",
            "onePasswordVault",
            "onePasswordItem",
            "colorTheme",
            "terminalFontSize",
            "attentionAnimation",
            "allowedSlashCommands",
            "channelMessaging",
        ] {
            assert!(json[key].is_null(), "{key}");
        }
        assert_eq!(json["defaultAllowedSlashCommands"][0], "compact");
    }

    #[test]
    fn allowed_slash_commands_are_normalized_and_deduplicated() {
        let (_dir, store) = temp_store();
        store
            .set_allowed_slash_commands(vec![
                "/Do-Code-Review".to_string(),
                " ".to_string(),
                "do-code-review".to_string(),
                "code-review-team-core:do-code-review".to_string(),
            ])
            .unwrap();
        assert_eq!(
            store.snapshot().allowed_slash_commands,
            Some(vec![
                "do-code-review".to_string(),
                "code-review-team-core:do-code-review".to_string(),
            ])
        );
        store.set_allowed_slash_commands(vec![]).unwrap();
        assert_eq!(store.snapshot().allowed_slash_commands, None);
    }

    #[test]
    fn a_slash_command_with_arguments_or_that_widens_the_session_is_rejected() {
        let (_dir, store) = temp_store();
        for bad in ["compact focus on tests", "review\n/login", "/permissions"] {
            assert!(store.set_allowed_slash_commands(vec![bad.into()]).is_err());
        }
        assert_eq!(store.snapshot().allowed_slash_commands, None);
    }

    #[test]
    fn a_blank_agent_field_clears_back_to_the_default() {
        let (_dir, store) = temp_store();
        store
            .set_agent(Some("Codex".into()), Some("codex --yolo".into()))
            .unwrap();
        assert_eq!(
            store.snapshot().agent_command.as_deref(),
            Some("codex --yolo")
        );
        store.set_agent(Some("   ".into()), None).unwrap();
        assert_eq!(store.snapshot().agent_name, None);
        assert_eq!(store.snapshot().agent_command, None);
    }

    #[test]
    fn a_control_character_in_the_agent_command_is_rejected() {
        let (_dir, store) = temp_store();
        for payload in [
            "claude\nrm -rf /",
            "claude\u{3}rm -rf /",
            "claude\u{15}rm -rf /",
        ] {
            assert!(store.set_agent(None, Some(payload.into())).is_err());
            assert_eq!(store.snapshot().agent_command, None);
        }
    }

    fn harness(id: &str, secret_env: &[&str]) -> AgentHarness {
        AgentHarness {
            id: id.to_string(),
            name: id.to_string(),
            kind: HarnessKind::Custom,
            command: "cloudbox run".to_string(),
            secret_env: secret_env.iter().map(|k| k.to_string()).collect(),
            ..AgentHarness::default()
        }
    }

    fn blob(store: &SettingsStore, backend: Arc<MemoryBackend>) -> SecretBlob {
        SecretBlob::with_store(memory(backend), store.clone())
    }

    fn harness_ids(store: &SettingsStore) -> Option<Vec<String>> {
        store
            .snapshot()
            .agent_harnesses
            .map(|list| list.into_iter().map(|h| h.id).collect())
    }

    #[test]
    fn a_harness_list_and_default_survive_and_the_built_in_is_stored_as_absent() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        store
            .set_agent_harnesses(&secrets, vec![harness("box", &[])], Some("box".into()))
            .unwrap();
        assert_eq!(harness_ids(&store), Some(vec!["box".to_string()]));
        assert_eq!(
            store.snapshot().default_agent_harness.as_deref(),
            Some("box")
        );

        store
            .set_agent_harnesses(&secrets, vec![], Some("claude".into()))
            .unwrap();
        assert_eq!(store.snapshot().agent_harnesses, None);
        assert_eq!(store.snapshot().default_agent_harness, None);
        let raw = std::fs::read_to_string(store.path()).unwrap();
        assert!(!raw.contains(r#""claude""#), "{raw}");
    }

    #[test]
    fn an_invalid_harness_list_is_rejected_and_nothing_is_stored() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        store
            .set_agent_harnesses(&secrets, vec![harness("box", &[])], None)
            .unwrap();
        for (list, default_id) in [
            (vec![harness("Not An Id", &[])], None),
            (vec![harness("box", &[]), harness("box", &[])], None),
            (vec![harness("box", &[])], Some("missing".to_string())),
        ] {
            assert!(
                store
                    .set_agent_harnesses(&secrets, list, default_id)
                    .is_err()
            );
            assert_eq!(harness_ids(&store), Some(vec!["box".to_string()]));
        }
    }

    /// A harness that reused the id and variable would otherwise be launched
    /// with a value stored for the one it replaced.
    #[test]
    fn a_dropped_secret_variable_loses_its_stored_value() {
        let (_dir, store) = temp_store();
        store
            .set_agent_harnesses(
                &blob(&store, MemoryBackend::empty()),
                vec![harness("box", &["TOKEN", "KEEP"])],
                None,
            )
            .unwrap();
        let held = MemoryBackend::holding(
            r#"{"agent_harness_env":{"box":{"TOKEN":"t","KEEP":"k"}},"github_token":"g"}"#,
        );
        store
            .set_agent_harnesses(
                &blob(&store, held.clone()),
                vec![harness("box", &["KEEP"])],
                None,
            )
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&held.contents().unwrap()).unwrap(),
            json!({ "agent_harness_env": { "box": { "KEEP": "k" } }, "github_token": "g" })
        );
    }

    /// Saving the list first would leave a value no later save can see as
    /// dropped, so a failed clear must stop the save.
    #[test]
    fn a_save_whose_dropped_secrets_cannot_be_cleared_stores_nothing() {
        let (_dir, store) = temp_store();
        store
            .set_agent_harnesses(
                &blob(&store, MemoryBackend::empty()),
                vec![harness("box", &["TOKEN"])],
                None,
            )
            .unwrap();
        let unreadable = blob(&store, MemoryBackend::unreadable());
        assert!(
            store
                .set_agent_harnesses(&unreadable, vec![], None)
                .is_err()
        );
        assert_eq!(harness_ids(&store), Some(vec!["box".to_string()]));
    }

    #[test]
    fn a_harness_secret_is_written_only_for_a_declared_variable() {
        let (_dir, store) = temp_store();
        let backend = MemoryBackend::empty();
        let secrets = blob(&store, backend.clone());
        assert!(
            store
                .set_agent_harness_secret(&secrets, "box", "TOKEN", Some("t".into()))
                .is_err()
        );
        assert!(backend.writes().is_empty());
        store
            .set_agent_harnesses(&secrets, vec![harness("box", &["TOKEN"])], None)
            .unwrap();
        store
            .set_agent_harness_secret(&secrets, "box", "TOKEN", Some("t".into()))
            .unwrap();
        let status = store.list_agent_harness_secret_status(&secrets).unwrap();
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!([{ "harnessId": "box", "key": "TOKEN", "present": true }])
        );
    }

    #[test]
    fn removing_a_harness_secret_works_for_any_name_and_drops_an_emptied_entry() {
        let mut subtree = json!({ "box": { "OLD": "o", "TOKEN": "t" } });
        let not_checked = || unreachable!("removal must not need a declared variable");
        assert_eq!(
            write_harness_secret(&mut subtree, "box", "OLD", None, not_checked),
            Ok(true)
        );
        assert_eq!(
            write_harness_secret(
                &mut subtree,
                "box",
                "TOKEN",
                Some(String::new()),
                not_checked
            ),
            Ok(true)
        );
        assert_eq!(subtree, json!({}));
        assert_eq!(
            write_harness_secret(&mut subtree, "box", "TOKEN", None, not_checked),
            Ok(false)
        );
    }

    #[test]
    fn a_blank_text_setting_clears_back_to_unset() {
        let (_dir, store) = temp_store();
        store
            .set_text_field(
                TextField::AzureDevopsOrgUrl,
                Some("https://dev.azure.com/acme".into()),
            )
            .unwrap();
        assert_eq!(
            store.snapshot().azure_devops_org_url.as_deref(),
            Some("https://dev.azure.com/acme")
        );
        store
            .set_text_field(TextField::AzureDevopsOrgUrl, Some("   ".into()))
            .unwrap();
        assert_eq!(store.snapshot().azure_devops_org_url, None);
    }

    /// Each field the Settings screen saves lands in its own key and reaches
    /// the sidecar under the variable it reads.
    #[test]
    fn the_jira_and_google_fields_are_stored_and_reach_the_sidecar() {
        let (_dir, store) = temp_store();
        store
            .set_text_field(
                TextField::JiraBaseUrl,
                Some(" https://acme.atlassian.net ".into()),
            )
            .unwrap();
        store
            .set_text_field(
                TextField::GoogleClientId,
                Some("123.apps.googleusercontent.com".into()),
            )
            .unwrap();
        let doc = read_document(&store);
        assert_eq!(doc["jiraBaseUrl"], "https://acme.atlassian.net");
        assert_eq!(doc["googleClientId"], "123.apps.googleusercontent.com");
        let env = crate::sidecar::sidecar_env(&json!({}), &store.snapshot());
        assert!(env.contains(&("JIRA_BASE_URL", "https://acme.atlassian.net".into())));
        assert!(env.contains(&("GOOGLE_CLIENT_ID", "123.apps.googleusercontent.com".into())));

        store.set_text_field(TextField::JiraBaseUrl, None).unwrap();
        store
            .set_text_field(TextField::GoogleClientId, Some("".into()))
            .unwrap();
        let settings = store.snapshot();
        assert_eq!(settings.jira_base_url, None);
        assert_eq!(settings.google_client_id, None);
    }

    #[cfg(unix)]
    #[test]
    fn the_settings_folder_is_created_private() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let yarvis = dir.path().join("home").join(".yarvis");
        let store = SettingsStore::new(yarvis.join("settings.json"));
        store.ensure_dir();
        let mode = std::fs::metadata(&yarvis).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
        // A folder another tool made too open is tightened.
        std::fs::set_permissions(&yarvis, std::fs::Permissions::from_mode(0o755)).unwrap();
        store.ensure_dir();
        let mode = std::fs::metadata(&yarvis).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o700);
    }

    #[test]
    fn small_settings_round_trip_and_zero_is_rejected() {
        let (_dir, store) = temp_store();
        store.set_channel_messaging(true).unwrap();
        assert_eq!(store.snapshot().channel_messaging, Some(true));
        store.set_channel_messaging(false).unwrap();
        assert_eq!(store.snapshot().channel_messaging, None);

        store
            .set_text_field(TextField::ColorTheme, Some("palenight".into()))
            .unwrap();
        store.set_terminal_font_size(Some(18)).unwrap();
        store.set_attention_animation(Some(false)).unwrap();
        store.set_telegram_otp_window_minutes(Some(45)).unwrap();
        let s = store.snapshot();
        assert_eq!(s.color_theme.as_deref(), Some("palenight"));
        assert_eq!(s.terminal_font_size, Some(18));
        assert_eq!(s.attention_animation, Some(false));
        assert_eq!(s.telegram_otp_window_minutes, Some(45));

        assert!(store.set_terminal_font_size(Some(0)).is_err());
        assert!(store.set_telegram_otp_window_minutes(Some(0)).is_err());
        assert_eq!(store.snapshot().terminal_font_size, Some(18));
    }

    #[test]
    fn legacy_keychain_values_are_migrated_and_secrets_stay() {
        let mut settings = Settings::default();
        let root = json!({
            "anthropic_api_key": "sk-ant-should-stay",
            "telegram_allowed_chat_ids": "123,456",
            "azure_devops_org_url": "https://dev.azure.com/acme",
            "jira_base_url": "https://acme.atlassian.net",
            "jira_email": "dev@acme.com",
            "google_client_id": "abc.apps.googleusercontent.com",
            "telegram_otp_window_minutes": "45",
        });
        let migrated = apply_legacy_migration(&mut settings, &root);
        assert_eq!(settings.jira_email.as_deref(), Some("dev@acme.com"));
        assert_eq!(settings.telegram_otp_window_minutes, Some(45));
        assert_eq!(migrated.len(), 5);
        assert!(!migrated.contains(&"telegram_allowed_chat_ids"));
    }

    #[test]
    fn migration_never_overwrites_and_discards_a_bad_otp_window() {
        let mut settings = Settings {
            jira_base_url: Some("https://mine.atlassian.net".into()),
            ..Settings::default()
        };
        let root = json!({
            "jira_base_url": "https://legacy.atlassian.net",
            "telegram_otp_window_minutes": "0",
        });
        let migrated = apply_legacy_migration(&mut settings, &root);
        assert_eq!(
            settings.jira_base_url.as_deref(),
            Some("https://mine.atlassian.net")
        );
        assert_eq!(settings.telegram_otp_window_minutes, None);
        assert_eq!(migrated, vec!["telegram_otp_window_minutes"]);
    }

    #[test]
    fn the_migration_moves_values_out_of_the_keychain_once() {
        let (_dir, store) = temp_store();
        let keychain_fake =
            MemoryBackend::holding(r#"{"jira_email":"dev@acme.com","github_token":"g"}"#);
        let keychain = memory(keychain_fake.clone());
        let secrets = SecretBlob::with_store(keychain.clone(), store.clone());
        store.migrate_keychain_settings(&secrets, &keychain);
        assert_eq!(store.snapshot().jira_email.as_deref(), Some("dev@acme.com"));
        assert_eq!(
            serde_json::from_str::<Value>(&keychain_fake.contents().unwrap()).unwrap(),
            json!({ "github_token": "g" })
        );
        store.migrate_keychain_settings(&secrets, &keychain);
        assert_eq!(
            keychain_fake.writes().len(),
            1,
            "a second start reads nothing"
        );
    }

    /// A Keychain that can't be read leaves the flag unset, so the next start
    /// tries again.
    #[test]
    fn an_unreadable_keychain_skips_the_migration_until_next_time() {
        let (_dir, store) = temp_store();
        let keychain = memory(MemoryBackend::unreadable());
        let secrets = SecretBlob::with_store(keychain.clone(), store.clone());
        store.migrate_keychain_settings(&secrets, &keychain);
        assert_eq!(store.snapshot().keychain_settings_migrated, None);
        assert!(!store.path().exists());
    }

    /// The settings are saved before the Keychain is touched, so a failed
    /// clear leaves the values in both places rather than in neither.
    #[test]
    fn a_keychain_that_cannot_be_cleared_still_keeps_the_migrated_values() {
        let (_dir, store) = temp_store();
        let held = r#"{"jira_email":"dev@acme.com"}"#;
        let fake = MemoryBackend::read_only(held);
        let keychain = memory(fake.clone());
        let secrets = SecretBlob::with_store(keychain.clone(), store.clone());
        store.migrate_keychain_settings(&secrets, &keychain);
        assert_eq!(store.snapshot().jira_email.as_deref(), Some("dev@acme.com"));
        assert_eq!(store.snapshot().keychain_settings_migrated, Some(true));
        assert_eq!(fake.contents().as_deref(), Some(held));
    }

    /// The sidecar keeps its own sections in this same file, so a save must
    /// carry them across, and a cleared field must not keep its value.
    #[test]
    fn a_save_keeps_the_sidecar_sections_and_clears_what_it_clears() {
        let (_dir, store) = temp_store();
        let providers = json!({ "litellm": { "baseUrl": "http://localhost:4000" } });
        std::fs::write(
            store.path(),
            json!({ "maxPtySessions": 5, "jiraEmail": "me@example.com", "customProviders": providers })
                .to_string(),
        )
        .unwrap();
        store.set_max_pty_sessions(Some(10)).unwrap();
        store.set_text_field(TextField::JiraEmail, None).unwrap();
        let doc = read_document(&store);
        assert_eq!(doc["customProviders"], providers);
        assert_eq!(doc["maxPtySessions"], 10);
        assert!(doc["jiraEmail"].is_null(), "{doc}");
    }

    fn guard(store: &SettingsStore) -> WriteGuard {
        SecretBlob::with_store(memory(MemoryBackend::empty()), store.clone())
            .lock_for_write()
            .unwrap()
    }

    #[test]
    fn an_empty_target_receives_the_source_blob() {
        let (_dir, store) = temp_store();
        let target = MemoryBackend::empty();
        let copied = copy_secrets(
            &guard(&store),
            &memory(MemoryBackend::holding(r#"{"github_token":"t"}"#)),
            &memory(target.clone()),
        )
        .unwrap();
        assert_eq!(copied, Copied::Secrets);
        assert_eq!(target.contents().unwrap(), r#"{"github_token":"t"}"#);
    }

    #[test]
    fn nothing_is_copied_from_an_empty_source() {
        let (_dir, store) = temp_store();
        let target = MemoryBackend::empty();
        let copied = copy_secrets(
            &guard(&store),
            &memory(MemoryBackend::empty()),
            &memory(target.clone()),
        )
        .unwrap();
        assert_eq!(copied, Copied::NothingToCopy);
        assert!(target.writes().is_empty());
    }

    /// Occupancy is judged on the raw text, so a hand-written note that isn't
    /// JSON is left alone too.
    #[test]
    fn an_occupied_target_is_left_alone() {
        let (_dir, store) = temp_store();
        for held in [r#"{"github_token":"theirs"}"#, "my recovery codes"] {
            let target = MemoryBackend::holding(held);
            let copied = copy_secrets(
                &guard(&store),
                &memory(MemoryBackend::holding(r#"{"github_token":"ours"}"#)),
                &memory(target.clone()),
            )
            .unwrap();
            assert_eq!(copied, Copied::TargetAlreadyHadSecrets);
            assert!(target.writes().is_empty());
        }
    }

    #[test]
    fn an_unreachable_or_unwritable_target_is_reported() {
        let (_dir, store) = temp_store();
        let source = || memory(MemoryBackend::holding(r#"{"github_token":"t"}"#));
        let err = copy_secrets(
            &guard(&store),
            &source(),
            &memory(MemoryBackend::unreadable()),
        )
        .unwrap_err();
        assert!(err.contains("the fake store"), "{err}");
        assert!(
            copy_secrets(
                &guard(&store),
                &source(),
                &memory(MemoryBackend::unwritable())
            )
            .is_err()
        );
    }

    #[test]
    fn a_backend_other_than_the_configured_one_is_refused() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        let err = store
            .set_secret_backend(
                &secrets,
                Some(SecretBackendKind::Keychain),
                "onepassword",
                None,
                None,
            )
            .unwrap_err();
        assert!(matches!(err, BackendSwitchError::NotConfigured));
        assert!(err.to_string().contains("server.toml"));
        assert!(matches!(
            store.set_secret_backend(
                &secrets,
                Some(SecretBackendKind::Keychain),
                "nope",
                None,
                None
            ),
            Err(BackendSwitchError::Invalid(_))
        ));
        assert_eq!(
            store
                .set_secret_backend(
                    &secrets,
                    Some(SecretBackendKind::Keychain),
                    "keychain",
                    None,
                    None
                )
                .unwrap(),
            Copied::Unchanged
        );
        assert!(!store.path().exists(), "a no-op switch saves nothing");
    }

    #[test]
    fn a_onepassword_switch_needs_a_vault_and_an_item() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        let err = store
            .set_secret_backend(
                &secrets,
                Some(SecretBackendKind::OnePassword),
                "onepassword",
                Some("Private".into()),
                None,
            )
            .unwrap_err();
        assert!(matches!(err, BackendSwitchError::Invalid(_)), "{err}");
    }

    /// With no backend in `server.toml`, the switch follows the desktop app's
    /// rules: `settings.json` holds the choice, and the vault can't be picked.
    #[test]
    fn with_no_configured_backend_settings_hold_the_choice() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        assert!(matches!(
            store.set_secret_backend(&secrets, None, "vault", None, None),
            Err(BackendSwitchError::NotConfigured)
        ));
        std::fs::write(
            store.path(),
            json!({ "secretBackend": "onepassword", "onePasswordVault": "Private", "onePasswordItem": "Yarvis" })
                .to_string(),
        )
        .unwrap();
        let copied = store
            .set_secret_backend(
                &secrets,
                None,
                "onepassword",
                Some("Private".into()),
                Some("Yarvis".into()),
            )
            .unwrap();
        assert_eq!(copied, Copied::Unchanged);
        assert!(store.snapshot().selects_onepassword());
    }

    /// A server whose `server.toml` picks 1Password, given its first item:
    /// the secrets the desktop app kept in the Keychain are copied in before
    /// the item is saved, so the switch doesn't leave the user with no keys.
    #[test]
    fn the_first_onepassword_item_is_filled_from_the_keychain() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        let keychain = MemoryBackend::holding(r#"{"github_token":"gho_kept"}"#);
        let item = MemoryBackend::empty();
        let probed = std::sync::Mutex::new(Vec::new());
        let copied = store
            .set_secret_backend_with(
                &secrets,
                Some(SecretBackendKind::OnePassword),
                "onepassword",
                Some("Private".into()),
                Some("Yarvis".into()),
                |target| match target {
                    Target::Keychain => memory(keychain.clone()),
                    Target::OnePassword(_) => memory(item.clone()),
                },
                |item| {
                    probed.lock().unwrap().push(item.clone());
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(copied, Copied::Secrets);
        assert_eq!(
            item.contents().as_deref(),
            Some(r#"{"github_token":"gho_kept"}"#)
        );
        assert_eq!(
            *probed.lock().unwrap(),
            vec![ItemRef::new("Private", "Yarvis").unwrap()]
        );
        // The Keychain copy stays, so a mistyped item can be switched back from.
        assert!(keychain.writes().is_empty());
        let settings = store.snapshot();
        assert_eq!(settings.one_password_vault.as_deref(), Some("Private"));
        assert_eq!(settings.one_password_item.as_deref(), Some("Yarvis"));
        assert!(settings.selects_onepassword());
    }

    /// A vault that can't be reached stops the switch before anything is
    /// copied or saved.
    #[test]
    fn a_failed_probe_copies_and_saves_nothing() {
        let (_dir, store) = temp_store();
        let secrets = blob(&store, MemoryBackend::empty());
        let item = MemoryBackend::empty();
        let err = store
            .set_secret_backend_with(
                &secrets,
                Some(SecretBackendKind::OnePassword),
                "onepassword",
                Some("Privat".into()),
                Some("Yarvis".into()),
                |target| match target {
                    Target::Keychain => memory(MemoryBackend::holding(r#"{"github_token":"t"}"#)),
                    Target::OnePassword(_) => memory(item.clone()),
                },
                |_| Err("1Password has no vault named 'Privat'".into()),
            )
            .unwrap_err();
        assert!(err.to_string().contains("Privat"), "{err}");
        assert!(item.writes().is_empty());
        assert!(!store.path().exists());
    }

    /// Re-saving the item already in use touches no store at all, so no `op`
    /// call is made.
    #[test]
    fn re_saving_the_same_item_is_unchanged() {
        let (_dir, store) = temp_store();
        std::fs::write(
            store.path(),
            json!({ "onePasswordVault": "Private", "onePasswordItem": "Yarvis" }).to_string(),
        )
        .unwrap();
        let secrets = blob(&store, MemoryBackend::empty());
        let copied = store
            .set_secret_backend(
                &secrets,
                Some(SecretBackendKind::OnePassword),
                "onepassword",
                Some(" Private ".into()),
                Some("Yarvis".into()),
            )
            .unwrap();
        assert_eq!(copied, Copied::Unchanged);
    }
}
