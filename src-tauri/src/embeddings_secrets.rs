//! Secret-only storage for the active embeddings provider.
//!
//! The structural config (base URL, model, dimensions, header names) lives in
//! the sidecar's Postgres database. Only credential material — the API key and
//! any custom header values — lives here, nested under one key in the shared
//! Keychain blob owned by [`crate::keychain`]: `{ "apiKey"?: string, "headers":
//! { "<name>": string } }`. That blob is injected into the sidecar at spawn
//! time as `YARVIS_EMBEDDINGS_SECRETS`.
//!
//! Unlike `custom_providers`, there is only one embeddings provider, so the
//! blob is a single secret bundle rather than a map keyed by provider id.
//!
//! This used to be its own standalone Keychain item, which cost a second
//! authorization prompt at startup on top of the shared item everything else
//! lives in. [`migrate_legacy_item`] folds any pre-existing value into the
//! shared item once and deletes the old one.

use std::collections::BTreeMap;

use keyring::Entry;
use serde::Serialize;
use serde_json::{Map, Value};

use crate::keychain;

/// Key under which the embeddings-provider credentials nest inside the shared
/// secrets blob. Keeping them in that one Keychain item means embeddings
/// secrets don't add a separate authorization prompt.
const EMBEDDINGS_KEY: &str = "embeddingsProvider";

/// Service/account of the standalone Keychain item this data lived in before
/// it was folded into the shared item, kept only for [`migrate_legacy_item`].
const LEGACY_SERVICE: &str = "com.mikebennett.yarvis";
const LEGACY_ACCOUNT: &str = "embeddings_provider_secrets";

/// Set in the shared root once the standalone item has been checked (and
/// migrated, if it had anything), so later startups never query it again —
/// otherwise every launch would cost a second Keychain item's worth of access
/// forever, the same problem this whole module now avoids for the credential
/// itself.
const LEGACY_MIGRATED_KEY: &str = "embeddingsProviderLegacyMigrated";

/// Migrates the pre-consolidation standalone Keychain item (`embeddings_provider_secrets`)
/// into the shared item, once, and deletes the old one. Call at startup before
/// the sidecar spawns so a migrated key is injected on the very first launch
/// after upgrading.
///
/// Order matters: the shared item is written — with the migrated value and
/// `LEGACY_MIGRATED_KEY` both in place — *before* the old item is deleted. If
/// the write fails, the old item and the not-yet-set flag are left alone so
/// the next launch retries from scratch; deleting first would risk losing the
/// only copy of the secret to a write that never lands.
pub fn migrate_legacy_item() {
    let mut root = keychain::read_root();
    if root.get(LEGACY_MIGRATED_KEY).and_then(Value::as_bool) == Some(true) {
        return;
    }
    let Some(entry) = Entry::new(LEGACY_SERVICE, LEGACY_ACCOUNT).ok() else {
        return;
    };
    let Ok(raw) = entry.get_password() else {
        // No legacy item (already migrated in a prior version, or never used)
        // — nothing to copy, but still worth recording so this lookup isn't
        // repeated on every future launch.
        if let Some(obj) = root.as_object_mut() {
            obj.insert(LEGACY_MIGRATED_KEY.to_string(), Value::Bool(true));
        }
        if let Err(e) = keychain::write_root(&root) {
            eprintln!("[embeddings_secrets] failed to persist legacy-item migration: {e}");
        }
        return;
    };
    let Some(obj) = root.as_object_mut() else {
        return;
    };
    if let Ok(blob) = serde_json::from_str::<Value>(&raw) {
        let has_content = blob.as_object().map(|o| !o.is_empty()).unwrap_or(false);
        if has_content && !obj.contains_key(EMBEDDINGS_KEY) {
            obj.insert(EMBEDDINGS_KEY.to_string(), blob);
        }
    }
    obj.insert(LEGACY_MIGRATED_KEY.to_string(), Value::Bool(true));
    if let Err(e) = keychain::write_root(&root) {
        eprintln!("[embeddings_secrets] failed to persist legacy-item migration: {e}");
        return;
    }
    let _ = entry.delete_credential();
}

/// Reads the embeddings-provider credential blob out of the shared secrets
/// blob.
fn read_blob() -> Value {
    blob_from_root(&keychain::read_root())
}

/// Extracts the embeddings-provider subtree from an already-read secrets blob.
fn blob_from_root(root: &Value) -> Value {
    root.get(EMBEDDINGS_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn write_blob(value: &Value) -> Result<(), String> {
    let mut root = keychain::read_root();
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "secrets store is not a JSON object".to_string())?;
    obj.insert(EMBEDDINGS_KEY.to_string(), value.clone());
    keychain::write_root(&root)
}

fn validate_slot(slot: &str) -> Result<(), String> {
    if slot == "apiKey" {
        return Ok(());
    }
    if let Some(name) = slot.strip_prefix("header:") {
        if !name.is_empty() {
            return Ok(());
        }
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

#[tauri::command]
pub fn get_embeddings_secret_status() -> EmbeddingsSecretStatus {
    let blob = read_blob();
    let obj = blob.as_object().cloned().unwrap_or_default();
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
    EmbeddingsSecretStatus {
        api_key_present,
        headers,
    }
}

#[tauri::command]
pub fn set_embeddings_secret(slot: String, value: String) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    if !blob.is_object() {
        blob = Value::Object(Map::new());
    }
    let obj = blob.as_object_mut().expect("root is always an object");
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
    write_blob(&blob)
}

#[tauri::command]
pub fn delete_embeddings_secret(slot: String) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    let Some(obj) = blob.as_object_mut() else {
        return Ok(());
    };
    if slot == "apiKey" {
        obj.remove("apiKey");
    } else {
        let name = slot.strip_prefix("header:").expect("validated above");
        if let Some(headers) = obj.get_mut("headers").and_then(|v| v.as_object_mut()) {
            headers.remove(name);
        }
    }
    write_blob(&blob)
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
    use super::validate_slot;

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
}
