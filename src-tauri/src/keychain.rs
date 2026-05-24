//! Keychain-backed secret storage.
//!
//! Secrets (API keys, the database URL) live in the macOS Keychain via the
//! `keyring` crate. The frontend can store and clear them and check presence,
//! but never reads values back after entry. The Rust core reads values only to
//! inject them into the sidecar's environment when spawning it.

use keyring::Entry;
use serde::Serialize;

/// Keychain service name under which all Yarvis secrets are grouped.
const SERVICE: &str = "com.mikebennett.yarvis";

/// The complete set of secrets the app manages. Writes to any other key are
/// rejected so the frontend cannot store arbitrary data in the Keychain.
pub const SECRET_KEYS: &[&str] = &[
    "anthropic_api_key",
    "gemini_api_key",
    "github_token",
    "database_url",
    "google_client_id",
    "google_client_secret",
];

#[derive(Serialize)]
pub struct SecretStatus {
    key: String,
    present: bool,
}

fn is_known(key: &str) -> bool {
    SECRET_KEYS.contains(&key)
}

fn entry(key: &str) -> Result<Entry, String> {
    Entry::new(SERVICE, key).map_err(|e| e.to_string())
}

/// Internal helper: read a secret value for injecting into the sidecar env.
pub fn read_secret(key: &str) -> Option<String> {
    entry(key).ok()?.get_password().ok()
}

#[tauri::command]
pub fn set_secret(key: String, value: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    entry(&key)?.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn get_secret_status(key: String) -> Result<bool, String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    match entry(&key)?.get_password() {
        Ok(_) => Ok(true),
        Err(keyring::Error::NoEntry) => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn delete_secret(key: String) -> Result<(), String> {
    if !is_known(&key) {
        return Err(format!("unknown secret key: {key}"));
    }
    match entry(&key)?.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn list_secret_status() -> Vec<SecretStatus> {
    SECRET_KEYS
        .iter()
        .map(|key| SecretStatus {
            key: (*key).to_string(),
            present: read_secret(key).is_some(),
        })
        .collect()
}
