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
//! A read that fails is *not* an empty store. Every write here is a
//! read-modify-write of the shared blob, so treating an unreachable store as
//! empty — which is what a locked 1Password or a dismissed Touch ID prompt
//! looks like — would erase every other secret in it on the next save. Hence
//! [`read_root`] is fallible and every caller refuses to write on an error.

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret_store::{self, Store};

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

/// Persists the secrets blob to `store`, replacing that item's contents.
pub fn write_root_to(store: &Store, root: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string(root).map_err(|e| e.to_string())?;
    store
        .write(&serialized)
        .map_err(|e| format!("could not save secrets to {}: {e}", store.label()))
}

/// Persists the secrets blob to the configured store.
pub fn write_root(root: &Value) -> Result<(), String> {
    write_root_to(&secret_store::active(), root)
}

/// Extracts a non-empty top-level secret from an already-read blob.
pub fn secret_from_root(root: &Value, key: &str) -> Option<String> {
    root.get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    let mut root = read_root()?;
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "secrets store is not a JSON object".to_string())?;
    obj.insert(key, Value::String(value));
    write_root(&root)
}

#[tauri::command]
pub fn get_secret_status(key: String) -> Result<bool, String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    Ok(secret_from_root(&read_root()?, &key).is_some())
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    let mut root = read_root()?;
    if let Some(obj) = root.as_object_mut() {
        obj.remove(&key);
    }
    write_root(&root)
}

#[tauri::command]
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
    use super::parse_root;
    use serde_json::json;

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
}
