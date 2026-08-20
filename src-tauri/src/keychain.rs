//! Keychain-backed secret storage.
//!
//! Every Yarvis secret (API keys, the database URL, and the custom-provider
//! credentials owned by [`crate::custom_providers`]) lives in a **single**
//! macOS Keychain item, stored as one JSON object. Using one item rather than
//! one-per-secret means the OS authorizes Keychain access once per session
//! instead of prompting for each secret in turn.
//!
//! The frontend can store and clear secrets and check presence, but never reads
//! values back after entry. The Rust core reads values only to inject them into
//! the sidecar's environment when spawning it (see [`read_root`]).

use keyring::Entry;
use serde::Serialize;
use serde_json::{Map, Value};

/// Keychain service name under which the Yarvis secret item is grouped.
const SERVICE: &str = "com.mikebennett.yarvis";

/// Account name of the single Keychain item that holds the secrets JSON object.
const SECRETS_ACCOUNT: &str = "secrets";

/// The complete set of top-level secrets the app manages. Writes to any other
/// key are rejected so the frontend cannot store arbitrary data in the Keychain.
pub const SECRET_KEYS: &[&str] = &[
    "anthropic_api_key",
    "gemini_api_key",
    "cerebras_api_key",
    "huggingface_api_key",
    "github_token",
    "azure_devops_token",
    "azure_devops_org_url",
    "jira_base_url",
    "jira_email",
    "jira_api_token",
    "database_url",
    "google_client_id",
    "google_client_secret",
    "telegram_bot_token",
    "telegram_allowed_chat_ids",
    "telegram_otp_secret",
    "telegram_otp_window_minutes",
];

#[derive(Serialize)]
pub struct SecretStatus {
    key: String,
    present: bool,
}

fn is_known(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, SECRETS_ACCOUNT).map_err(|e| e.to_string())
}

/// Reads the entire secrets blob as a JSON object, returning an empty object
/// when nothing has been stored yet. Reading touches the single Keychain item,
/// so callers that need several values should call this once and read fields
/// from the result rather than re-reading per key.
pub fn read_root() -> Value {
    let raw = match entry().and_then(|e| match e.get_password() {
        Ok(s) => Ok(Some(s)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }) {
        Ok(Some(s)) => s,
        // Missing item or read error: treat as "no secrets stored".
        _ => return Value::Object(Map::new()),
    };
    serde_json::from_str(&raw).unwrap_or_else(|_| Value::Object(Map::new()))
}

/// Persists the secrets blob, replacing the single Keychain item's contents.
pub fn write_root(root: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string(root).map_err(|e| e.to_string())?;
    entry()?
        .set_password(&serialized)
        .map_err(|e| e.to_string())
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
    let mut root = read_root();
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
    Ok(secret_from_root(&read_root(), &key).is_some())
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    let mut root = read_root();
    if let Some(obj) = root.as_object_mut() {
        obj.remove(&key);
    }
    write_root(&root)
}

#[tauri::command]
pub fn list_secret_status() -> Vec<SecretStatus> {
    // One read covers every key's presence, so Settings loads with a single
    // Keychain access rather than one per secret.
    let root = read_root();
    SECRET_KEYS
        .iter()
        .map(|key| SecretStatus {
            key: (*key).to_string(),
            present: secret_from_root(&root, key).is_some(),
        })
        .collect()
}
