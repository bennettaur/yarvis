//! The app's secret blob: what it holds and who may write to it.
//!
//! Every Yarvis secret (API keys, the database URL, and the custom-provider,
//! MCP-server, and embeddings-provider credentials owned by their respective
//! modules) lives in a **single** item, stored as one JSON object. Using one
//! item rather than one-per-secret means the store authorizes access once per
//! session instead of prompting for each secret in turn — every module that
//! needs credential storage nests its data under a key in this shared blob
//! rather than opening its own item.
//!
//! Which store that item lives in — the macOS Keychain or 1Password — is
//! `secret_store.rs`'s decision, and nothing here or downstream depends on the
//! answer.
//!
//! Non-sensitive configuration that used to ride this blob purely to keep its
//! injection path uniform with real credentials (an org URL, an account email)
//! has moved to `settings.rs`'s `~/.yarvis/settings.json`; `settings::init`
//! migrates any values it finds here on first run. A value only belongs here if
//! it's actually a credential or an authorization boundary — the Telegram
//! chat-id allowlist stays for the latter reason: with OTP off by default, it's
//! the bot's only access-control check, and a plain settings file has no
//! per-item authorization gate the way a secret store does.
//!
//! The frontend can store and clear secrets and check presence, but never reads
//! values back after entry. The Rust core reads values only to inject them into
//! the sidecar's environment when spawning it (see [`read_root`]).
//!
//! Every command here is `#[tauri::command(async)]`, so it runs off the main
//! thread: a store access can block on an authorization prompt the user has not
//! answered, and a sync command would freeze the window while it waited
//! (`clipboard.rs` marks its one blocking command the same way).
//!
//! A read that fails is *not* an empty store. Every write here is a
//! read-modify-write of the shared blob, so treating an unreachable store as
//! empty — which is what a locked 1Password or a dismissed Touch ID prompt
//! looks like — would erase every other secret in it on the next save. Hence
//! [`read_root`] is fallible and every caller refuses to write on an error.
//!
//! For the same reason, two writes must not overlap: each would save its own
//! copy of the blob, and the one that lands second drops the other's change.
//! Writers come from the webview, the sidecar's control channel and startup
//! migrations, and from every running app instance, since instances share the
//! item. So every write holds [`lock_for_write`] from the read to the write,
//! usually through [`update_root`] or [`update_root_in`].

use std::fs::{File, OpenOptions, TryLockError as FileTryLockError};
#[cfg(unix)]
use std::os::unix::fs::OpenOptionsExt;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, MutexGuard, TryLockError};
use std::time::{Duration, Instant};

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret_store::{self, Store};
use crate::settings;

/// The complete set of top-level secrets the app manages. Writes to any other
/// key are rejected so the frontend cannot store arbitrary data in the secret
/// store. Non-secret configuration that used to sit alongside these (org URLs,
/// an account email) now lives in `settings.rs` instead — the private
/// `LEGACY_SETTING_KEYS` list there does the migration off this list.
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

#[derive(Serialize)]
pub struct SecretStatus {
    key: String,
    present: bool,
}

fn is_known(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

/// Parses a stored blob into the root object. A blob that isn't valid JSON
/// reads as empty, which is what a store holding something we didn't write
/// looks like — the alternative is an app that can neither read nor reset it.
fn parse_root(blob: Option<String>) -> Value {
    blob.and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_else(|| Value::Object(Map::new()))
}

/// Reads the entire secrets blob as a JSON object from the given store,
/// returning an empty object when nothing has been stored yet.
pub fn read_root_from(store: &Store) -> Result<Value, String> {
    store
        .read()
        .map(parse_root)
        .map_err(|e| format!("could not read secrets from {}: {e}", store.label()))
}

/// Reads the entire secrets blob from the configured store. Reading touches the
/// single item, so callers that need several values should call this once and
/// read fields from the result rather than re-reading per key.
pub fn read_root() -> Result<Value, String> {
    read_root_from(&secret_store::active())
}

/// Persists the secrets blob to `store`, replacing that item's contents. Takes
/// the write guard so only a caller holding the lock can write.
pub fn write_root_to(_guard: &WriteGuard, store: &Store, root: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string(root).map_err(|e| e.to_string())?;
    store
        .write(&serialized)
        .map_err(|e| format!("could not save secrets to {}: {e}", store.label()))
}

/// Serializes writers inside this process. The file lock alone would too, but it
/// needs `~/.yarvis`, which is unknown until settings load and absent in tests.
static WRITE_LOCK: Mutex<()> = Mutex::new(());

/// Proof that this caller holds the secrets write lock; dropping it releases
/// the lock.
pub struct WriteGuard {
    // Fields drop in order: the file lock is released before the mutex.
    _file: Option<File>,
    _local: MutexGuard<'static, ()>,
}

/// How long a writer waits for the lock. The slowest holder is a switch between
/// stores, which makes several 1Password calls of up to a minute each; past
/// that, the holder is stuck (an unanswered system prompt) and waiting longer
/// only hangs this window too.
const LOCK_WAIT: Duration = Duration::from_secs(180);
const LOCK_POLL: Duration = Duration::from_millis(50);

const LOCK_BUSY: &str =
    "another Yarvis window is still saving secrets; try again once it has finished";

/// Waits for, and takes, the lock every write of the secrets blob holds. It
/// covers both stores, so a write and a switch between stores can't interleave
/// either. A writer that panicked left nothing half-written in the store, so a
/// poisoned mutex is still safe to take.
pub fn lock_for_write() -> Result<WriteGuard, String> {
    let deadline = Instant::now() + LOCK_WAIT;
    let local = loop {
        match WRITE_LOCK.try_lock() {
            Ok(guard) => break guard,
            Err(TryLockError::Poisoned(poisoned)) => break poisoned.into_inner(),
            Err(TryLockError::WouldBlock) => wait_until(deadline)?,
        }
    };
    let file = match settings::secrets_lock_path() {
        Some(path) => Some(lock_file(&path, deadline)?),
        None => {
            warn_unlocked_across_instances();
            None
        }
    };
    Ok(WriteGuard {
        _file: file,
        _local: local,
    })
}

/// Waits for an exclusive lock on `path`, which other instances take too. The
/// OS releases it when the file closes, so an instance that crashes mid-write
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
                return Err(format!("could not lock {}: {e}", path.display()))
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

/// Settings failed to load, so there is no `~/.yarvis` for the lock file and
/// writes are ordered only within this process. Said once, not per write.
fn warn_unlocked_across_instances() {
    static WARNED: AtomicBool = AtomicBool::new(false);
    if !cfg!(test) && !WARNED.swap(true, Ordering::Relaxed) {
        eprintln!(
            "[secrets] settings path unknown; secret writes aren't locked against other instances"
        );
    }
}

/// Reads the blob from `store`, lets `edit` change it, and writes it back,
/// holding [`lock_for_write`] throughout. `edit` returns whether it changed
/// anything; when it didn't, nothing is written, which spares a 1Password user
/// a prompt for a no-op.
pub fn update_root_in(
    store: &Store,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    let guard = lock_for_write()?;
    update_root_locked(&guard, store, edit)
}

/// [`update_root_in`] for the configured store. The store is looked up after
/// the lock is taken, so a switch to another store that finished while this
/// write waited is honored.
pub fn update_root(edit: impl FnOnce(&mut Value) -> Result<bool, String>) -> Result<(), String> {
    let guard = lock_for_write()?;
    update_root_locked(&guard, &secret_store::active(), edit)
}

fn update_root_locked(
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

/// [`update_root`] for a module that keeps its credentials in one subtree of
/// the blob under `key`. `edit` always sees an object: a missing subtree, or
/// one that isn't an object, reads as `{}`.
pub fn update_subtree(
    key: &str,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    update_root(|root| edit_subtree(root, key, edit))
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

/// Stores the GitHub token the sidecar received from a device-flow sign-in.
/// Reached over the control channel, so it writes only `github_token` and
/// checks the token instead of trusting the sidecar.
pub fn store_github_token(token: &str) -> Result<(), String> {
    validate_github_token(token)?;
    set_secret("github_token".to_string(), token.to_string())
}

/// GitHub tokens are at most 255 printable ASCII characters.
fn validate_github_token(token: &str) -> Result<(), String> {
    if token.is_empty() || token.len() > 255 || !token.chars().all(|c| c.is_ascii_graphic()) {
        return Err("invalid github token".to_string());
    }
    Ok(())
}

#[tauri::command(async)]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    update_root(|root| {
        let obj = root.as_object_mut().expect("checked by update_root");
        obj.insert(key, Value::String(value));
        Ok(true)
    })
}

#[tauri::command(async)]
pub fn get_secret_status(key: String) -> Result<bool, String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    Ok(secret_from_root(&read_root()?, &key).is_some())
}

#[tauri::command(async)]
pub fn delete_secret(key: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    update_root(|root| {
        let obj = root.as_object_mut().expect("checked by update_root");
        Ok(obj.remove(&key).is_some())
    })
}

#[tauri::command(async)]
pub fn list_secret_status() -> Result<Vec<SecretStatus>, String> {
    // One read covers every key's presence, so Settings loads with a single
    // store access rather than one per secret.
    let root = read_root()?;
    Ok(SECRET_KEYS
        .iter()
        .map(|key| SecretStatus {
            key: (*key).to_string(),
            present: secret_from_root(&root, key).is_some(),
        })
        .collect())
}

#[cfg(test)]
mod tests {
    use super::{
        edit_subtree, lock_file, parse_root, read_root_from, update_root_in, validate_github_token,
        LOCK_BUSY,
    };
    use crate::secret_store::{MemoryStore, Store};
    use serde_json::json;
    use std::time::{Duration, Instant};

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
        assert_eq!(parse_root(Some(String::new())), json!({}));
    }

    #[test]
    fn a_stored_blob_reads_back_as_written() {
        assert_eq!(
            parse_root(Some(r#"{"github_token":"t"}"#.to_string())),
            json!({ "github_token": "t" })
        );
    }

    /// The invariant the whole fallible-read change exists for: a store that
    /// cannot be read must never let a write proceed, because every write here
    /// is a read-modify-write of one shared blob and would save the caller's
    /// single key over everything else.
    #[test]
    fn an_unreadable_store_yields_an_error_naming_it() {
        let store = Store::Memory(MemoryStore::unreadable());
        let err = read_root_from(&store).unwrap_err();
        assert!(err.contains("the fake store"), "{err}");
    }

    /// The other half of that invariant, stated where a future refactor would
    /// trip over it: nothing was written on the failed read above.
    #[test]
    fn a_failed_read_leaves_the_store_untouched() {
        let fake = MemoryStore::unreadable();
        let store = Store::Memory(fake.clone());
        assert!(read_root_from(&store).is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn a_reachable_empty_store_reads_as_an_empty_root() {
        let store = Store::Memory(MemoryStore::empty());
        assert_eq!(read_root_from(&store).unwrap(), json!({}));
    }

    /// Writing one key must carry the rest of the blob with it — the nested
    /// subtrees `mcp` and `custom_providers` own live in here too.
    #[test]
    fn writing_one_key_preserves_every_other() {
        let fake = MemoryStore::holding(r#"{"mcpServers":{"a":{}},"github_token":"old"}"#);
        let store = Store::Memory(fake.clone());

        update_root_in(&store, |root| {
            root.as_object_mut()
                .unwrap()
                .insert("github_token".to_string(), json!("new"));
            Ok(true)
        })
        .unwrap();

        assert_eq!(
            read_root_from(&store).unwrap(),
            json!({ "mcpServers": { "a": {} }, "github_token": "new" })
        );
    }

    /// The race the write lock exists for: writers that each read the blob,
    /// add their own key and write it back must not drop each other's keys.
    #[test]
    fn concurrent_writers_keep_every_change() {
        let fake = MemoryStore::empty();
        let store = Store::Memory(fake.clone());
        std::thread::scope(|scope| {
            for i in 0..16 {
                let store = &store;
                scope.spawn(move || {
                    update_root_in(store, |root| {
                        // Widens the window between this writer's read and its write.
                        std::thread::sleep(std::time::Duration::from_millis(2));
                        root.as_object_mut()
                            .unwrap()
                            .insert(format!("key{i}"), json!(i));
                        Ok(true)
                    })
                    .unwrap();
                });
            }
        });
        let root = read_root_from(&store).unwrap();
        assert_eq!(root.as_object().unwrap().len(), 16);
    }

    #[test]
    fn an_edit_that_changes_nothing_writes_nothing() {
        let fake = MemoryStore::holding(r#"{"github_token":"t"}"#);
        let store = Store::Memory(fake.clone());
        update_root_in(&store, |_| Ok(false)).unwrap();
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn a_failed_read_writes_nothing() {
        let fake = MemoryStore::unreadable();
        let store = Store::Memory(fake.clone());
        assert!(update_root_in(&store, |_| Ok(true)).is_err());
        assert!(fake.writes().is_empty());
    }

    /// Another instance holding the lock file keeps this one out until it
    /// closes, and a writer gives up rather than waiting forever.
    #[test]
    fn the_lock_file_shuts_out_a_second_holder_until_released() {
        let path =
            std::env::temp_dir().join(format!("yarvis-secrets-lock-test-{}", std::process::id()));
        let soon = || Instant::now() + Duration::from_millis(100);
        let held = lock_file(&path, soon()).unwrap();
        assert_eq!(lock_file(&path, soon()).unwrap_err(), LOCK_BUSY);
        drop(held);
        assert!(lock_file(&path, soon()).is_ok());
        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn a_subtree_edit_keeps_sibling_keys() {
        let store = Store::Memory(MemoryStore::holding(
            r#"{"github_token":"t","mcpServers":{"a":{}}}"#,
        ));
        update_root_in(&store, |root| {
            edit_subtree(root, "mcpServers", |servers| {
                servers
                    .as_object_mut()
                    .unwrap()
                    .insert("b".into(), json!({}));
                Ok(true)
            })
        })
        .unwrap();
        assert_eq!(
            read_root_from(&store).unwrap(),
            json!({ "github_token": "t", "mcpServers": { "a": {}, "b": {} } })
        );
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
    fn a_subtree_edit_that_changes_nothing_leaves_the_root_alone() {
        let mut root = json!({ "github_token": "t" });
        assert!(!edit_subtree(&mut root, "mcpServers", |_| Ok(false)).unwrap());
        assert_eq!(root, json!({ "github_token": "t" }));
    }
}
