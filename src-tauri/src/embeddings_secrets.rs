//! Secret-only storage for the active embeddings provider.
//!
//! The structural config (base URL, model, dimensions, header names) lives in
//! the sidecar's Postgres database. Only credential material — the API key and
//! any custom header values — lives here, in the macOS Keychain, as a single
//! entry (`embeddings_provider_secrets`) holding a JSON object:
//! `{ "apiKey"?: string, "headers": { "<name>": string } }`. That blob is
//! injected into the sidecar at spawn time as `YARVIS_EMBEDDINGS_SECRETS`.
//!
//! Unlike `custom_providers`, there is only one embeddings provider, so the blob
//! is a single secret bundle rather than a map keyed by provider id.

use std::collections::BTreeMap;

use keyring::Entry;
use serde::Serialize;
use serde_json::{Map, Value};

/// Keychain service name shared with `keychain.rs` so the user sees a single
/// Yarvis bundle in Keychain Access.
const SERVICE: &str = "com.mikebennett.yarvis";
const SECRETS_KEY: &str = "embeddings_provider_secrets";

fn entry() -> Result<Entry, String> {
    Entry::new(SERVICE, SECRETS_KEY).map_err(|e| e.to_string())
}

fn read_blob() -> Value {
    let raw = match entry().and_then(|e| {
        e.get_password().map_err(|err| match err {
            keyring::Error::NoEntry => "missing".to_string(),
            other => other.to_string(),
        })
    }) {
        Ok(s) => s,
        Err(_) => return Value::Object(Map::new()),
    };
    serde_json::from_str(&raw).unwrap_or(Value::Object(Map::new()))
}

fn write_blob(value: &Value) -> Result<(), String> {
    let serialized = serde_json::to_string(value).map_err(|e| e.to_string())?;
    entry()?
        .set_password(&serialized)
        .map_err(|e| e.to_string())
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
/// when nothing is stored.
pub fn build_sidecar_env() -> Option<String> {
    let blob = read_blob();
    if blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    serde_json::to_string(&blob).ok()
}
