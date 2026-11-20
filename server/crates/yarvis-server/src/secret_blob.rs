//! The secrets blob: what it holds and who may write to it.
//!
//! Every Yarvis secret (API keys, the database URL, and the custom-provider,
//! MCP-server, embeddings-provider and harness credentials owned by their
//! modules) lives in a **single** item, stored as one JSON object. One item
//! rather than one per secret means the store authorizes access once instead of
//! prompting for each secret in turn, so every module that needs credential
//! storage nests its data under a key in this blob rather than opening its own
//! item.
//!
//! Which store holds the item is chosen by `[secrets] backend` in
//! `server.toml` ([`crate::secret_store`]). Nothing here or downstream depends
//! on the answer. The 1Password item's vault and title come from
//! `settings.json` and are read on every access, so a switch to another item is
//! honored at once.
//!
//! Clients can store and clear secrets and check presence, but never read
//! values back. The server reads values only to inject them into the sidecar's
//! environment and the sessions that need them.
//!
//! A read that fails is *not* an empty store. Every write here is a
//! read-modify-write of the shared blob, so treating an unreachable store as
//! empty (a locked 1Password, a dismissed Touch ID prompt, a locked vault)
//! would erase every other secret on the next save. Hence [`SecretBlob::read_root`]
//! is fallible and every caller refuses to write on an error.
//!
//! For the same reason, two writes must not overlap: each would save its own
//! copy of the blob, and the one that lands second drops the other's change.
//! Writers come from HTTP requests, the sidecar's control channel and startup
//! migrations, and from a desktop app running beside the server,
//! since they share the item. So every write holds [`SecretBlob::lock_for_write`]
//! from the read to the write, usually through [`SecretBlob::update_root`].
//!
//! Every call here blocks (a Keychain prompt, an `op` call of up to a minute,
//! the lock wait), so async callers run them on the blocking pool.

use std::fs::{File, OpenOptions, TryLockError as FileTryLockError};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::{Arc, Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::config::SecretBackendKind;
use crate::secret_store::SecretBackend;
use crate::secret_store::keychain::KeychainBackend;
use crate::secret_store::onepassword::{ItemRef, OnePasswordBackend};
use crate::settings::SettingsStore;

/// The complete set of top-level secrets clients may write. Writes to any
/// other key are rejected so a client cannot store arbitrary data in the
/// secret store.
pub const SECRET_KEYS: &[&str] = &[
    "anthropic_api_key",
    "gemini_api_key",
    "cerebras_api_key",
    "huggingface_api_key",
    "github_token",
    "azure_devops_token",
    "jira_api_token",
    "database_url",
    "google_client_secret",
    "verify_agent_signing_key",
    "telegram_bot_token",
    "telegram_allowed_chat_ids",
    "telegram_otp_secret",
];

/// A backend and the name it goes by in an error the user reads.
#[derive(Clone)]
pub struct Store {
    pub label: &'static str,
    pub backend: Arc<dyn SecretBackend>,
}

impl Store {
    pub fn keychain() -> Self {
        Self {
            label: "the macOS Keychain",
            backend: Arc::new(KeychainBackend),
        }
    }

    pub fn onepassword(item: ItemRef) -> Self {
        Self {
            label: "1Password",
            backend: Arc::new(OnePasswordBackend::new(item)),
        }
    }

    /// The raw stored text, or `None` when nothing is stored.
    pub fn read_raw(&self) -> Result<Option<String>, String> {
        self.backend
            .read_root()
            .map_err(|e| format!("could not read secrets from {}: {e}", self.label))
    }
}

#[derive(Clone)]
enum Selection {
    /// `server.toml` names no backend, so `settings.json`'s `secretBackend`
    /// decides on every access, as it does for the desktop app.
    FromSettings,
    Keychain,
    /// The item named by `onePasswordVault`/`onePasswordItem` in settings.
    OnePassword,
    /// A store chosen by whoever built this blob: tests, and the vault.
    Fixed(Store),
    /// A backend that can't be used, with the reason.
    Unusable(&'static str),
}

/// The secrets blob, in whichever store the server is configured to use.
#[derive(Clone)]
pub struct SecretBlob {
    selection: Selection,
    settings: SettingsStore,
}

#[derive(Serialize)]
pub struct SecretStatus {
    key: String,
    present: bool,
}

impl SecretBlob {
    /// The blob in the store `kind` names, or the one `settings.json` names
    /// when `kind` is unset. The vault backend isn't built yet, so it gives a
    /// blob whose every access fails; `main` refuses to start with it rather
    /// than run a server that can't read its secrets.
    pub fn from_config(kind: Option<SecretBackendKind>, settings: SettingsStore) -> Self {
        let selection = match kind {
            None => Selection::FromSettings,
            Some(SecretBackendKind::Keychain) => Selection::Keychain,
            Some(SecretBackendKind::OnePassword) => Selection::OnePassword,
            Some(SecretBackendKind::Vault) => Selection::Unusable(VAULT_NOT_BUILT),
        };
        Self {
            selection,
            settings,
        }
    }

    /// The blob in `store`, whatever the config says.
    pub fn with_store(store: Store, settings: SettingsStore) -> Self {
        Self {
            selection: Selection::Fixed(store),
            settings,
        }
    }

    pub fn settings(&self) -> &SettingsStore {
        &self.settings
    }

    /// The store in use right now. Settings are read on every call, so a
    /// switch made since, here or by a desktop app sharing the file, is
    /// honored.
    ///
    /// A 1Password selection with no usable item is an error rather than a
    /// fallback to the Keychain: reading or writing somewhere else would leave
    /// the user looking at one store while their secrets went to another.
    pub fn active(&self) -> Result<Store, String> {
        let onepassword = || {
            self.settings
                .snapshot()
                .onepassword_item()
                .map(Store::onepassword)
                .map_err(|e| {
                    format!("the 1Password backend needs a vault and an item in Settings: {e}")
                })
        };
        match &self.selection {
            Selection::FromSettings if self.settings.snapshot().selects_onepassword() => {
                onepassword()
            }
            Selection::FromSettings | Selection::Keychain => Ok(Store::keychain()),
            Selection::OnePassword => onepassword(),
            Selection::Fixed(store) => Ok(store.clone()),
            Selection::Unusable(reason) => Err((*reason).to_string()),
        }
    }

    /// Reads the entire secrets blob from the configured store. Callers that
    /// need several values read once and pick fields from the result.
    pub fn read_root(&self) -> Result<Value, String> {
        read_root_from(&self.active()?)
    }

    /// Waits for, and takes, the lock every write of the secrets blob holds:
    /// a mutex within this process plus `secrets.lock` beside `settings.json`,
    /// which the desktop app takes too. A writer that panicked left nothing
    /// half-written in the store, so a poisoned mutex is still safe to take.
    pub fn lock_for_write(&self) -> Result<WriteGuard, String> {
        let deadline = Instant::now() + LOCK_WAIT;
        let local = loop {
            match WRITE_LOCK.try_lock() {
                Ok(guard) => break guard,
                Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
                Err(TryLockError::WouldBlock) => wait_until(deadline)?,
            }
        };
        let file = lock_file(&self.settings.secrets_lock_path(), deadline)?;
        Ok(WriteGuard {
            _file: file,
            _local: local,
        })
    }

    /// Reads the blob, lets `edit` change it, and writes it back, holding the
    /// write lock throughout. `edit` returns whether it changed anything; when
    /// it didn't, nothing is written, which spares a 1Password user a prompt
    /// for a no-op. The store is looked up after the lock is taken, so a switch
    /// that finished while this write waited is honored.
    pub fn update_root(
        &self,
        edit: impl FnOnce(&mut Value) -> Result<bool, String>,
    ) -> Result<(), String> {
        let guard = self.lock_for_write()?;
        update_root_locked(&guard, &self.active()?, edit)
    }

    /// [`Self::update_root`] for a module that keeps its credentials in one
    /// subtree of the blob under `key`. `edit` always sees an object: a missing
    /// subtree, or one that isn't an object, reads as `{}`.
    pub fn update_subtree(
        &self,
        key: &str,
        edit: impl FnOnce(&mut Value) -> Result<bool, String>,
    ) -> Result<(), String> {
        self.update_root(|root| edit_subtree(root, key, edit))
    }

    pub fn set_secret(&self, key: &str, value: String) -> Result<(), String> {
        check_known(key)?;
        self.update_root(|root| {
            let obj = root.as_object_mut().expect("checked by update_root");
            obj.insert(key.to_string(), Value::String(value));
            Ok(true)
        })
    }

    pub fn get_secret_status(&self, key: &str) -> Result<bool, String> {
        check_known(key)?;
        Ok(secret_from_root(&self.read_root()?, key).is_some())
    }

    pub fn delete_secret(&self, key: &str) -> Result<(), String> {
        check_known(key)?;
        self.update_root(|root| {
            let obj = root.as_object_mut().expect("checked by update_root");
            Ok(obj.remove(key).is_some())
        })
    }

    /// Every key's presence from one read, so Settings loads with a single
    /// store access rather than one per secret.
    pub fn list_secret_status(&self) -> Result<Vec<SecretStatus>, String> {
        let root = self.read_root()?;
        Ok(SECRET_KEYS
            .iter()
            .map(|key| SecretStatus {
                key: (*key).to_string(),
                present: secret_from_root(&root, key).is_some(),
            })
            .collect())
    }

    /// Stores the GitHub token the sidecar received from a device-flow sign-in.
    /// Reached over the control channel, so it writes only `github_token` and
    /// checks the token instead of trusting the sidecar.
    pub fn store_github_token(&self, token: &str) -> Result<(), String> {
        validate_github_token(token)?;
        self.set_secret("github_token", token.to_string())
    }
}

const VAULT_NOT_BUILT: &str = "the vault backend isn't built yet; set [secrets] backend to \"keychain\" or \"onepassword\" in server.toml";

fn check_known(key: &str) -> Result<(), String> {
    if SECRET_KEYS.contains(&key) {
        Ok(())
    } else {
        Err(format!("unknown secret key: {key}"))
    }
}

/// Parses a stored blob into the root object. A blob that isn't valid JSON
/// reads as empty, which is what a store holding something we didn't write
/// looks like. The alternative is a server that can neither read nor reset it.
fn parse_root(blob: Option<String>) -> Value {
    blob.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// Reads the entire secrets blob as a JSON object from `store`, returning an
/// empty object when nothing has been stored yet.
pub fn read_root_from(store: &Store) -> Result<Value, String> {
    store.read_raw().map(parse_root)
}

/// Persists the secrets blob to `store`, replacing that item's contents. Takes
/// the write guard so only a caller holding the lock can write.
pub fn write_root_to(_guard: &WriteGuard, store: &Store, root: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string(root).map_err(|e| e.to_string())?;
    store
        .backend
        .write_root(&serialized)
        .map_err(|e| format!("could not save secrets to {}: {e}", store.label))
}

/// [`SecretBlob::update_root`] against `store`, for a caller that already holds
/// the write lock because it has more to do under it.
pub fn update_root_locked(
    guard: &WriteGuard,
    store: &Store,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    let mut root = read_root_from(store)?;
    if !root.is_object() {
        return Err("secrets store is not a JSON object".to_string());
    }
    if edit(&mut root)? {
        write_root_to(guard, store, &root)?;
    }
    Ok(())
}

/// [`SecretBlob::update_subtree`] against `store`, under a lock the caller holds.
pub fn update_subtree_locked(
    guard: &WriteGuard,
    store: &Store,
    key: &str,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    update_root_locked(guard, store, |root| edit_subtree(root, key, edit))
}

fn edit_subtree(
    root: &mut Value,
    key: &str,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<bool, String> {
    let obj = root.as_object_mut().expect("checked by update_root");
    let mut subtree = obj
        .get(key)
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    if !edit(&mut subtree)? {
        return Ok(false);
    }
    obj.insert(key.to_string(), subtree);
    Ok(true)
}

/// Extracts a non-empty top-level secret from an already-read blob.
pub fn secret_from_root(root: &Value, key: &str) -> Option<String> {
    root.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// GitHub tokens are at most 255 printable ASCII characters.
fn validate_github_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 255 || !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("invalid github token".to_string());
    }
    Ok(())
}

/// Serializes writers inside this process. Static rather than per
/// [`SecretBlob`] because every blob in a process shares one store item.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Proof that this caller holds the secrets write lock; dropping it releases
/// the lock.
pub struct WriteGuard {
    // Fields drop in order: the file lock is released before the mutex.
    _file: File,
    _local: MutexGuard<'static, ()>,
}

/// How long a writer waits for the lock. The slowest holder is a switch between
/// 1Password items, which makes several `op` calls of up to a minute each; past
/// that, the holder is stuck on an unanswered prompt and waiting longer only
/// hangs this request too.
const LOCK_WAIT: Duration = Duration::from_secs(180);
const LOCK_POLL: Duration = Duration::from_millis(50);

const LOCK_BUSY: &str =
    "another Yarvis process is still saving secrets; try again once it has finished";

/// Waits for an exclusive lock on `path`, which other processes take too. The
/// OS releases it when the file closes, so a process that crashes mid-write
/// doesn't leave the lock held.
fn lock_file(path: &Path, deadline: Instant) -> Result<File, String> {
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).write(true);
    #[cfg(unix)]
    options.mode(0o600);
    let file = options
        .open(path)
        .map_err(|e| format!("could not open {}: {e}", path.display()))?;
    loop {
        match file.try_lock() {
            Ok(()) => return Ok(file),
            Err(FileTryLockError::WouldBlock) => wait_until(deadline)?,
            Err(FileTryLockError::Error(e)) => {
                return Err(format!("could not lock {}: {e}", path.display()));
            }
        }
    }
}

fn wait_until(deadline: Instant) -> Result<(), String> {
    if Instant::now() >= deadline {
        return Err(LOCK_BUSY.to_string());
    }
    std::thread::sleep(LOCK_POLL);
    Ok(())
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use crate::secret_store::memory::MemoryBackend;
    use serde_json::json;

    pub(crate) fn memory(backend: Arc<MemoryBackend>) -> Store {
        Store {
            label: "the fake store",
            backend,
        }
    }

    pub(crate) fn blob_over(dir: &Path, backend: Arc<MemoryBackend>) -> SecretBlob {
        SecretBlob::with_store(
            memory(backend),
            SettingsStore::new(dir.join("settings.json")),
        )
    }

    #[test]
    fn a_github_token_must_be_one_printable_word() {
        assert!(validate_github_token("gho_abc123").is_ok());
        assert!(validate_github_token("").is_err());
        assert!(validate_github_token("gho_abc\n123").is_err());
        assert!(validate_github_token("gho abc").is_err());
        assert!(validate_github_token(&"a".repeat(256)).is_err());
    }

    #[test]
    fn an_absent_or_unparseable_blob_reads_as_an_empty_object() {
        assert_eq!(parse_root(None), json!({}));
        assert_eq!(parse_root(Some("not json".to_string())), json!({}));
        assert_eq!(
            parse_root(Some(r#"{"github_token":"t"}"#.to_string())),
            json!({ "github_token": "t" })
        );
    }

    /// The invariant the fallible read exists for: a store that cannot be read
    /// must never let a write proceed, because every write is a
    /// read-modify-write of one shared blob and would save the caller's single
    /// key over everything else.
    #[test]
    fn a_failed_read_names_the_store_and_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unreadable();
        let blob = blob_over(dir.path(), fake.clone());
        let err = blob.read_root().unwrap_err();
        assert!(err.contains("the fake store"), "{err}");
        assert!(blob.set_secret("github_token", "t".into()).is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn writing_one_key_preserves_every_other() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::holding(r#"{"mcpServers":{"a":{}},"github_token":"old"}"#);
        let blob = blob_over(dir.path(), fake);
        blob.set_secret("github_token", "new".into()).unwrap();
        assert_eq!(
            blob.read_root().unwrap(),
            json!({ "mcpServers": { "a": {} }, "github_token": "new" })
        );
    }

    #[test]
    fn an_unknown_key_is_refused_for_every_operation() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::empty();
        let blob = blob_over(dir.path(), fake.clone());
        assert!(blob.set_secret("mcpServers", "x".into()).is_err());
        assert!(blob.delete_secret("mcpServers").is_err());
        assert!(blob.get_secret_status("mcpServers").is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn status_reports_presence_and_delete_removes() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(r#"{"github_token":"t","gemini_api_key":""}"#),
        );
        assert!(blob.get_secret_status("github_token").unwrap());
        assert!(!blob.get_secret_status("gemini_api_key").unwrap());
        let listed = blob.list_secret_status().unwrap();
        assert_eq!(listed.len(), SECRET_KEYS.len());
        blob.delete_secret("github_token").unwrap();
        assert!(!blob.get_secret_status("github_token").unwrap());
    }

    /// The race the write lock exists for: writers that each read the blob,
    /// add their own key and write it back must not drop each other's keys.
    #[test]
    fn concurrent_writers_keep_every_change() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(dir.path(), MemoryBackend::empty());
        std::thread::scope(|scope| {
            for i in 0..16 {
                let blob = &blob;
                scope.spawn(move || {
                    blob.update_root(|root| {
                        // Widens the window between this writer's read and its write.
                        std::thread::sleep(Duration::from_millis(2));
                        root.as_object_mut()
                            .unwrap()
                            .insert(format!("key{i}"), json!(i));
                        Ok(true)
                    })
                    .unwrap();
                });
            }
        });
        assert_eq!(blob.read_root().unwrap().as_object().unwrap().len(), 16);
    }

    #[test]
    fn an_edit_that_changes_nothing_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::holding(r#"{"github_token":"t"}"#);
        blob_over(dir.path(), fake.clone())
            .update_root(|_| Ok(false))
            .unwrap();
        assert!(fake.writes().is_empty());
    }

    /// Another process holding the lock file keeps this one out until it
    /// closes, and a writer gives up rather than waiting forever.
    #[test]
    fn the_lock_file_shuts_out_a_second_holder_until_released() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("secrets.lock");
        let soon = || Instant::now() + Duration::from_millis(100);
        let held = lock_file(&path, soon()).unwrap();
        assert_eq!(lock_file(&path, soon()).unwrap_err(), LOCK_BUSY);
        drop(held);
        assert!(lock_file(&path, soon()).is_ok());
    }

    #[test]
    fn a_subtree_edit_keeps_sibling_keys() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(r#"{"github_token":"t","mcpServers":{"a":{}}}"#),
        );
        blob.update_subtree("mcpServers", |servers| {
            servers
                .as_object_mut()
                .unwrap()
                .insert("b".into(), json!({}));
            Ok(true)
        })
        .unwrap();
        assert_eq!(
            blob.read_root().unwrap(),
            json!({ "github_token": "t", "mcpServers": { "a": {}, "b": {} } })
        );
    }

    /// What keeps a desktop app beside the server from writing at the same
    /// time: the blob's lock takes `secrets.lock` beside `settings.json`.
    #[test]
    fn the_write_lock_holds_the_shared_lock_file() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(dir.path(), MemoryBackend::empty());
        let path = blob.settings().secrets_lock_path();
        let soon = || Instant::now() + Duration::from_millis(100);
        let guard = blob.lock_for_write().unwrap();
        assert_eq!(lock_file(&path, soon()).unwrap_err(), LOCK_BUSY);
        drop(guard);
        assert!(lock_file(&path, soon()).is_ok());
    }

    #[test]
    fn a_subtree_edit_that_changes_nothing_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::holding(r#"{"github_token":"t"}"#);
        blob_over(dir.path(), fake.clone())
            .update_subtree("mcpServers", |_| Ok(false))
            .unwrap();
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn a_subtree_that_is_not_an_object_reads_as_empty() {
        let mut root = json!({ "mcpServers": "garbage" });
        edit_subtree(&mut root, "mcpServers", |servers| {
            assert_eq!(servers, &json!({}));
            Ok(true)
        })
        .unwrap();
        assert_eq!(root, json!({ "mcpServers": {} }));
    }

    #[test]
    fn the_vault_backend_fails_clearly_rather_than_falling_back() {
        let dir = tempfile::tempdir().unwrap();
        let blob = SecretBlob::from_config(
            Some(SecretBackendKind::Vault),
            SettingsStore::new(dir.path().join("settings.json")),
        );
        let err = blob.read_root().unwrap_err();
        assert!(err.contains("vault backend isn't built yet"), "{err}");
    }

    /// With no backend in `server.toml`, the desktop app's choice in
    /// `settings.json` decides, so an existing 1Password install stays on it.
    #[test]
    fn an_unset_backend_follows_settings() {
        let dir = tempfile::tempdir().unwrap();
        let settings = SettingsStore::new(dir.path().join("settings.json"));
        let blob = SecretBlob::from_config(None, settings.clone());
        assert_eq!(blob.active().unwrap().label, "the macOS Keychain");
        std::fs::write(
            settings.path(),
            json!({ "secretBackend": "onepassword", "onePasswordVault": "Private", "onePasswordItem": "Yarvis" })
                .to_string(),
        )
        .unwrap();
        assert_eq!(blob.active().unwrap().label, "1Password");
        std::fs::write(
            settings.path(),
            json!({ "secretBackend": "onepassword" }).to_string(),
        )
        .unwrap();
        let err = blob.active().err().unwrap();
        assert!(err.contains("needs a vault and an item"), "{err}");
    }

    /// A server told to use 1Password must not quietly use the Keychain while
    /// the item is unset.
    #[test]
    fn onepassword_without_an_item_is_an_error_not_the_keychain() {
        let dir = tempfile::tempdir().unwrap();
        let blob = SecretBlob::from_config(
            Some(SecretBackendKind::OnePassword),
            SettingsStore::new(dir.path().join("settings.json")),
        );
        let err = blob.read_root().unwrap_err();
        assert!(err.contains("needs a vault and an item"), "{err}");
    }
}
