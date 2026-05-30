//! Secret-only storage for user-configured proxy providers.
//!
//! The structural data (name, baseURL, apiKind, models, headerNames) lives in
//! the sidecar's Postgres database. Only credential material — the API key
//! and any custom header values — lives here, in the macOS Keychain. We use a
//! single Keychain entry (`custom_provider_secrets`) that holds a JSON map:
//! `{ "<provider-id>": { "apiKey"?: string, "headers": { "<name>": string } } }`.
//! That blob is injected into the sidecar at spawn time as the
//! `YARVIS_CUSTOM_PROVIDER_SECRETS` env var.

use std::collections::BTreeMap;

use keyring::Entry;
use serde::Serialize;
use serde_json::{Map, Value};

/// Keychain service name shared with `keychain.rs` so the user sees a single
/// Yarvis bundle in Keychain Access.
const SERVICE: &str = "com.mikebennett.yarvis";
const SECRETS_KEY: &str = "custom_provider_secrets";

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

fn provider_entry<'a>(blob: &'a mut Value, id: &str) -> &'a mut Map<String, Value> {
    let obj = blob.as_object_mut().expect("root is always an object");
    if !obj.contains_key(id) {
        obj.insert(id.to_string(), Value::Object(Map::new()));
    }
    obj.get_mut(id)
        .expect("just inserted")
        .as_object_mut()
        .expect("provider entries are objects")
}

/// Header names the user must not be able to override on outbound provider
/// requests. Keeps the sidecar's RESERVED_HEADER_NAMES set and this Rust
/// validator in lockstep — both guard the same surface from different angles.
const RESERVED_HEADER_NAMES: &[&str] = &[
    "authorization",
    "proxy-authorization",
    "cookie",
    "host",
    "content-length",
    "transfer-encoding",
    "connection",
];

const MAX_HEADER_NAME_LEN: usize = 64;

/// Matches the RFC 7230 token charset: `!#$%&'*+-.^_`|~` plus alphanumerics.
fn is_header_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric()
        || matches!(
            c,
            '!' | '#'
                | '$'
                | '%'
                | '&'
                | '\''
                | '*'
                | '+'
                | '-'
                | '.'
                | '^'
                | '_'
                | '`'
                | '|'
                | '~'
        )
}

fn validate_header_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("header name is empty".to_string());
    }
    if name.len() > MAX_HEADER_NAME_LEN {
        return Err(format!(
            "header name exceeds {MAX_HEADER_NAME_LEN} characters"
        ));
    }
    if !name.chars().all(is_header_token_char) {
        return Err("header name must match RFC 7230 token charset".to_string());
    }
    if RESERVED_HEADER_NAMES.contains(&name.to_ascii_lowercase().as_str()) {
        return Err(format!("header name '{name}' is reserved"));
    }
    Ok(())
}

fn validate_slot(slot: &str) -> Result<(), String> {
    if slot == "apiKey" {
        return Ok(());
    }
    if let Some(name) = slot.strip_prefix("header:") {
        return validate_header_name(name);
    }
    Err(format!("unknown secret slot: {slot}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CustomProviderSecretStatus {
    pub provider_id: String,
    pub api_key_present: bool,
    /// Header name → whether a value is stored.
    pub headers: BTreeMap<String, bool>,
}

#[tauri::command]
pub fn list_custom_provider_secret_status() -> Vec<CustomProviderSecretStatus> {
    let blob = read_blob();
    let obj = blob.as_object().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(obj.len());
    for (id, entry) in obj {
        let entry_obj = entry.as_object().cloned().unwrap_or_default();
        let api_key_present = entry_obj
            .get("apiKey")
            .and_then(|v| v.as_str())
            .filter(|s| !s.is_empty())
            .is_some();
        let mut headers = BTreeMap::new();
        if let Some(headers_obj) = entry_obj.get("headers").and_then(|v| v.as_object()) {
            for (name, value) in headers_obj {
                let present = value
                    .as_str()
                    .map(|s| !s.is_empty())
                    .unwrap_or(false);
                headers.insert(name.clone(), present);
            }
        }
        out.push(CustomProviderSecretStatus {
            provider_id: id,
            api_key_present,
            headers,
        });
    }
    out
}

#[tauri::command]
pub fn set_custom_provider_secret(
    provider_id: String,
    slot: String,
    value: String,
) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    if !blob.is_object() {
        blob = Value::Object(Map::new());
    }
    let provider = provider_entry(&mut blob, &provider_id);
    if slot == "apiKey" {
        provider.insert("apiKey".into(), Value::String(value));
    } else {
        let name = slot.strip_prefix("header:").expect("validated above");
        let headers = provider
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
pub fn delete_custom_provider_secret(
    provider_id: String,
    slot: String,
) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    let Some(root) = blob.as_object_mut() else {
        return Ok(());
    };
    let Some(provider) = root.get_mut(&provider_id).and_then(|v| v.as_object_mut())
    else {
        return Ok(());
    };
    if slot == "apiKey" {
        provider.remove("apiKey");
    } else {
        let name = slot.strip_prefix("header:").expect("validated above");
        if let Some(headers) = provider.get_mut("headers").and_then(|v| v.as_object_mut()) {
            headers.remove(name);
        }
    }
    // Drop the provider entirely if it has no remaining secrets.
    let provider_empty = provider
        .get("apiKey")
        .and_then(|v| v.as_str())
        .filter(|s| !s.is_empty())
        .is_none()
        && provider
            .get("headers")
            .and_then(|v| v.as_object())
            .map(|h| h.is_empty())
            .unwrap_or(true);
    if provider_empty {
        root.remove(&provider_id);
    }
    write_blob(&blob)
}

/// Deletes every secret slot belonging to the given provider id. Called from
/// the frontend when a custom provider is removed from the database so no
/// orphan credentials linger in the Keychain.
#[tauri::command]
pub fn delete_custom_provider_all_secrets(provider_id: String) -> Result<(), String> {
    let mut blob = read_blob();
    let Some(root) = blob.as_object_mut() else {
        return Ok(());
    };
    if root.remove(&provider_id).is_some() {
        write_blob(&blob)?;
    }
    Ok(())
}

/// Returns the raw JSON blob to inject as `YARVIS_CUSTOM_PROVIDER_SECRETS`, or
/// `None` when nothing is stored.
pub fn build_sidecar_env() -> Option<String> {
    let blob = read_blob();
    if blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    serde_json::to_string(&blob).ok()
}
