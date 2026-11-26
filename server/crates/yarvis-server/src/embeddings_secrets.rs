//! Secret-only storage for the active embeddings provider.
//!
//! The structural config (base URL, model, dimensions, header names) lives in
//! the sidecar's Postgres database. Only credential material — the API key and
//! any custom header values — lives here, nested under one key in the shared
//! secrets blob owned by [`crate::secret_blob`]: `{ "apiKey"?: string,
//! "headers": { "<name>": string } }`. That blob is injected into the sidecar
//! at spawn time as `YARVIS_EMBEDDINGS_SECRETS`.
//!
//! Unlike `custom_providers`, there is only one embeddings provider, so the
//! blob is a single secret bundle rather than a map keyed by provider id.
//!
//! Older builds kept it in its own standalone Keychain item, which cost a second
//! authorization prompt at startup on top of the shared item everything else
//! lives in. [`migrate_legacy_item`] folds any pre-existing value into the
//! shared item once and deletes the old one.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret_blob::{self, SecretBlob, Store};

/// Key under which the embeddings-provider credentials nest inside the shared
/// secrets blob. Keeping them in that one item means embeddings secrets don't
/// add a separate authorization prompt.
const EMBEDDINGS_KEY: &str = "embeddingsProvider";

/// Set in the shared root once the standalone item has been checked (and
/// migrated, if it had anything), so later startups never query it again —
/// otherwise every launch would cost a second Keychain item's worth of access
/// forever, the same problem this whole module avoids for the credential
/// itself.
const LEGACY_MIGRATED_KEY: &str = "embeddingsProviderLegacyMigrated";

/// The standalone Keychain item this data lived in before it was folded into
/// the shared item, kept only for [`migrate_legacy_item`]. A trait so the
/// migration can be tested without touching the real Keychain.
trait LegacyItem {
    /// The stored text, or `None` when there is no item (or it can't be read).
    fn read(&self) -> Option<String>;
    fn delete(&self);
}

/// Service/account of the standalone Keychain item.
#[cfg(target_os = "macos")]
const LEGACY_SERVICE: &str = crate::secret_store::keychain::SERVICE;
#[cfg(target_os = "macos")]
const LEGACY_ACCOUNT: &str = "embeddings_provider_secrets";

struct LegacyKeychainItem;

#[cfg(target_os = "macos")]
impl LegacyItem for LegacyKeychainItem {
    fn read(&self) -> Option<String> {
        keyring::Entry::new(LEGACY_SERVICE, LEGACY_ACCOUNT)
            .ok()?
            .get_password()
            .ok()
    }

    fn delete(&self) {
        if let Ok(entry) = keyring::Entry::new(LEGACY_SERVICE, LEGACY_ACCOUNT) {
            let _ = entry.delete_credential();
        }
    }
}

/// Off macOS there is no Keychain, so there is never a legacy item.
#[cfg(not(target_os = "macos"))]
impl LegacyItem for LegacyKeychainItem {
    fn read(&self) -> Option<String> {
        None
    }

    fn delete(&self) {}
}

/// Migrates the pre-consolidation standalone Keychain item
/// (`embeddings_provider_secrets`) into the shared item in `keychain`, once,
/// and deletes the old one. Call at startup before the sidecar spawns so a
/// migrated key is injected on the very first launch after upgrading. `blob`
/// supplies the write lock.
///
/// Order matters: the shared item is written — with the migrated value and
/// `LEGACY_MIGRATED_KEY` both in place — *before* the old item is deleted. If
/// the write fails, the old item and the not-yet-set flag are left alone so
/// the next launch retries from scratch; deleting first would risk losing the
/// only copy of the secret to a write that never lands.
pub fn migrate_legacy_item(blob: &SecretBlob, keychain: &Store) {
    migrate_from(blob, keychain, &LegacyKeychainItem);
}

fn migrate_from(blob: &SecretBlob, keychain: &Store, legacy: &dyn LegacyItem) {
    let already_migrated =
        |root: &Value| root.get(LEGACY_MIGRATED_KEY).and_then(Value::as_bool) == Some(true);
    // Checked once without the lock: every launch after the first finds the
    // flag set, and startup shouldn't wait on another process's secret write.
    if secret_blob::read_root_from(keychain).is_ok_and(|root| already_migrated(&root)) {
        return;
    }
    let mut found_legacy = false;
    let migrated = blob.lock_for_write().and_then(|guard| {
        secret_blob::update_root_locked(&guard, keychain, |root| {
            if already_migrated(root) {
                return Ok(false);
            }
            let obj = root.as_object_mut().expect("checked by update_root_locked");
            // With no legacy item (already migrated in a prior version, or never
            // used), the flag is still set below so this lookup isn't repeated on
            // every launch.
            if let Some(raw) = legacy.read() {
                if let Ok(value) = serde_json::from_str::<Value>(&raw) {
                    let has_content = value.as_object().map(|o| !o.is_empty()).unwrap_or(false);
                    if has_content && !obj.contains_key(EMBEDDINGS_KEY) {
                        obj.insert(EMBEDDINGS_KEY.to_string(), value);
                    }
                }
                found_legacy = true;
            }
            obj.insert(LEGACY_MIGRATED_KEY.to_string(), Value::Bool(true));
            Ok(true)
        })
    });
    match migrated {
        Ok(()) => {
            if found_legacy {
                legacy.delete();
            }
        }
        Err(e) => tracing::warn!("[embeddings_secrets] legacy-item migration failed: {e}"),
    }
}

/// Reads the embeddings-provider credential blob out of the shared secrets
/// blob.
fn read_blob(blob: &SecretBlob) -> Result<Value, String> {
    Ok(blob_from_root(&blob.read_root()?))
}

/// Extracts the embeddings-provider subtree from an already-read secrets blob.
fn blob_from_root(root: &Value) -> Value {
    root.get(EMBEDDINGS_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn update_blob(
    blob: &SecretBlob,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    blob.update_subtree(EMBEDDINGS_KEY, edit)
}

fn validate_slot(slot: &str) -> Result<(), String> {
    if slot == "apiKey" {
        return Ok(());
    }
    if let Some(name) = slot.strip_prefix("header:")
        && !name.is_empty()
    {
        return Ok(());
    }
    Err(format!("unknown secret slot: {slot}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EmbeddingsSecretStatus {
    pub api_key_present: bool,
    /// Header name → whether a value is stored.
    pub headers: BTreeMap<String, bool>,
}

pub fn get_embeddings_secret_status(blob: &SecretBlob) -> Result<EmbeddingsSecretStatus, String> {
    let secrets = read_blob(blob)?;
    let obj = secrets.as_object().cloned().unwrap_or_default();
    let api_key_present = obj
        .get("apiKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .is_some();
    let mut headers = BTreeMap::new();
    if let Some(headers_obj) = obj.get("headers").and_then(|v| v.as_object()) {
        for (name, value) in headers_obj {
            let present = value.as_str().map(|s| !s.is_empty()).unwrap_or(false);
            headers.insert(name.clone(), present);
        }
    }
    Ok(EmbeddingsSecretStatus {
        api_key_present,
        headers,
    })
}

pub fn set_embeddings_secret(blob: &SecretBlob, slot: String, value: String) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let obj = subtree.as_object_mut().expect("subtree is an object");
        if slot == "apiKey" {
            obj.insert("apiKey".into(), Value::String(value));
        } else {
            let name = slot.strip_prefix("header:").expect("validated above");
            let headers = obj
                .entry("headers")
                .or_insert_with(|| Value::Object(Map::new()));
            if !headers.is_object() {
                *headers = Value::Object(Map::new());
            }
            headers
                .as_object_mut()
                .expect("just ensured")
                .insert(name.to_string(), Value::String(value));
        }
        Ok(true)
    })
}

pub fn delete_embeddings_secret(blob: &SecretBlob, slot: String) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let obj = subtree.as_object_mut().expect("subtree is an object");
        let removed = if slot == "apiKey" {
            obj.remove("apiKey").is_some()
        } else {
            let name = slot.strip_prefix("header:").expect("validated above");
            obj.get_mut("headers")
                .and_then(|v| v.as_object_mut())
                .is_some_and(|headers| headers.remove(name).is_some())
        };
        Ok(removed)
    })
}

/// Returns the raw JSON blob to inject as `YARVIS_EMBEDDINGS_SECRETS`, or `None`
/// when nothing is stored. Takes the already-read secrets blob so the sidecar
/// spawn reads the Keychain only once.
pub fn build_sidecar_env(root: &Value) -> Option<String> {
    let blob = blob_from_root(root);
    if blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    serde_json::to_string(&blob).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_blob::tests::{blob_over, memory};
    use crate::secret_store::memory::MemoryBackend;
    use serde_json::json;
    use std::cell::Cell;

    #[test]
    fn accepts_api_key_and_named_headers() {
        assert!(validate_slot("apiKey").is_ok());
        assert!(validate_slot("header:X-Tenant").is_ok());
    }

    #[test]
    fn rejects_empty_or_unknown_slots() {
        assert!(validate_slot("").is_err());
        assert!(validate_slot("header:").is_err());
        assert!(validate_slot("apikey").is_err()); // case-sensitive
        assert!(validate_slot("password").is_err());
    }

    /// A store that can't be read must never be treated as empty, or the next
    /// save would replace every other secret with this one.
    #[test]
    fn a_failed_read_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unreadable();
        let blob = blob_over(dir.path(), fake.clone());
        assert!(get_embeddings_secret_status(&blob).is_err());
        assert!(set_embeddings_secret(&blob, "apiKey".into(), "k".into()).is_err());
        assert!(delete_embeddings_secret(&blob, "apiKey".into()).is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn set_status_and_delete_round_trip_without_touching_siblings() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(r#"{"github_token":"t"}"#),
        );
        set_embeddings_secret(&blob, "apiKey".into(), "k".into()).unwrap();
        set_embeddings_secret(&blob, "header:X-Tenant".into(), "v".into()).unwrap();
        let status = get_embeddings_secret_status(&blob).unwrap();
        assert!(status.api_key_present);
        assert_eq!(status.headers.get("X-Tenant"), Some(&true));
        delete_embeddings_secret(&blob, "apiKey".into()).unwrap();
        delete_embeddings_secret(&blob, "header:X-Tenant".into()).unwrap();
        assert!(!get_embeddings_secret_status(&blob).unwrap().api_key_present);
        assert_eq!(
            blob.read_root().unwrap()["github_token"],
            json!("t"),
            "sibling key survives"
        );
    }

    #[test]
    fn the_status_serializes_with_the_camel_case_names_the_client_reads() {
        let status = EmbeddingsSecretStatus {
            api_key_present: true,
            headers: BTreeMap::new(),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({ "apiKeyPresent": true, "headers": {} })
        );
    }

    struct FakeLegacy {
        content: Option<&'static str>,
        deleted: Cell<bool>,
    }

    impl LegacyItem for FakeLegacy {
        fn read(&self) -> Option<String> {
            self.content.map(str::to_string)
        }
        fn delete(&self) {
            self.deleted.set(true);
        }
    }

    fn legacy(content: Option<&'static str>) -> FakeLegacy {
        FakeLegacy {
            content,
            deleted: Cell::new(false),
        }
    }

    #[test]
    fn migration_moves_the_legacy_value_in_sets_the_flag_and_deletes_the_old_item() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::holding(r#"{"github_token":"t"}"#);
        let blob = blob_over(dir.path(), fake.clone());
        let old = legacy(Some(r#"{"apiKey":"k"}"#));
        migrate_from(&blob, &memory(fake), &old);
        assert_eq!(
            blob.read_root().unwrap(),
            json!({
                "github_token": "t",
                "embeddingsProvider": { "apiKey": "k" },
                "embeddingsProviderLegacyMigrated": true
            })
        );
        assert!(old.deleted.get());
    }

    #[test]
    fn migration_never_overwrites_a_value_already_in_the_shared_item() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::holding(r#"{"embeddingsProvider":{"apiKey":"new"}}"#);
        let blob = blob_over(dir.path(), fake.clone());
        migrate_from(&blob, &memory(fake), &legacy(Some(r#"{"apiKey":"old"}"#)));
        assert_eq!(
            blob.read_root().unwrap()["embeddingsProvider"],
            json!({ "apiKey": "new" })
        );
    }

    #[test]
    fn migration_with_no_legacy_item_still_sets_the_flag_and_runs_once() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::empty();
        let blob = blob_over(dir.path(), fake.clone());
        let old = legacy(None);
        migrate_from(&blob, &memory(fake.clone()), &old);
        assert!(!old.deleted.get());
        assert_eq!(fake.writes().len(), 1);
        migrate_from(
            &blob,
            &memory(fake.clone()),
            &legacy(Some(r#"{"apiKey":"k"}"#)),
        );
        assert_eq!(fake.writes().len(), 1, "flag stops a second run");
    }

    /// If the shared item can't be written, the old item is the only copy.
    #[test]
    fn a_failed_write_keeps_the_legacy_item() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unwritable();
        let blob = blob_over(dir.path(), fake.clone());
        let old = legacy(Some(r#"{"apiKey":"k"}"#));
        migrate_from(&blob, &memory(fake), &old);
        assert!(!old.deleted.get());
    }

    #[test]
    fn migration_writes_nothing_when_the_shared_item_is_unreadable() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unreadable();
        let blob = blob_over(dir.path(), fake.clone());
        let old = legacy(Some(r#"{"apiKey":"k"}"#));
        migrate_from(&blob, &memory(fake.clone()), &old);
        assert!(fake.writes().is_empty());
        assert!(!old.deleted.get());
    }
}
