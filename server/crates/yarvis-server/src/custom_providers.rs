//! Secret-only storage for user-configured proxy providers.
//!
//! The structural data (name, baseURL, apiKind, models, headerNames) lives in
//! the sidecar's Postgres database. Only credential material — the API key
//! and any custom header values — lives here, in the secrets store. It nests under one key of the
//! shared secrets blob and holds a JSON map:
//! `{ "<provider-id>": { "apiKey"?: string, "headers": { "<name>": string } } }`.
//! That blob is injected into the sidecar at spawn time as the
//! `YARVIS_CUSTOM_PROVIDER_SECRETS` env var.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret_blob::SecretBlob;

/// Key under which the custom-provider credentials nest inside the shared
/// secrets blob owned by [`crate::secret_blob`]. Keeping them in that one
/// item means custom-provider secrets don't add a separate authorization prompt.
const CUSTOM_PROVIDERS_KEY: &str = "customProviders";

/// Reads the custom-provider credential map out of the shared secrets blob.
fn read_blob(blob: &SecretBlob) -> Result<Value, String> {
    Ok(providers_from_root(&blob.read_root()?))
}

/// Extracts the custom-provider subtree from an already-read secrets blob.
fn providers_from_root(root: &Value) -> Value {
    root.get(CUSTOM_PROVIDERS_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn update_blob(
    blob: &SecretBlob,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    blob.update_subtree(CUSTOM_PROVIDERS_KEY, edit)
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

pub fn list_custom_provider_secret_status(
    blob: &SecretBlob,
) -> Result<Vec<CustomProviderSecretStatus>, String> {
    let secrets = read_blob(blob)?;
    let obj = secrets.as_object().cloned().unwrap_or_default();
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
                let present = value.as_str().map(|s| !s.is_empty()).unwrap_or(false);
                headers.insert(name.clone(), present);
            }
        }
        out.push(CustomProviderSecretStatus {
            provider_id: id,
            api_key_present,
            headers,
        });
    }
    Ok(out)
}

pub fn set_custom_provider_secret(
    blob: &SecretBlob,
    provider_id: String,
    slot: String,
    value: String,
) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let provider = provider_entry(subtree, &provider_id);
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
        Ok(true)
    })
}

pub fn delete_custom_provider_secret(
    blob: &SecretBlob,
    provider_id: String,
    slot: String,
) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let root = subtree.as_object_mut().expect("subtree is an object");
        let Some(provider) = root.get_mut(&provider_id).and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let removed = if slot == "apiKey" {
            provider.remove("apiKey").is_some()
        } else {
            let name = slot.strip_prefix("header:").expect("validated above");
            provider
                .get_mut("headers")
                .and_then(|v| v.as_object_mut())
                .is_some_and(|headers| headers.remove(name).is_some())
        };
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
        let pruned = provider_empty && root.remove(&provider_id).is_some();
        Ok(removed || pruned)
    })
}

/// Deletes every secret slot belonging to the given provider id. Called by the
/// client when a custom provider is removed from the database so no orphan
/// credentials linger in the secrets store.
pub fn delete_custom_provider_all_secrets(
    blob: &SecretBlob,
    provider_id: String,
) -> Result<(), String> {
    update_blob(blob, |subtree| {
        let root = subtree.as_object_mut().expect("subtree is an object");
        Ok(root.remove(&provider_id).is_some())
    })
}

/// Returns the raw JSON blob to inject as `YARVIS_CUSTOM_PROVIDER_SECRETS`, or
/// `None` when nothing is stored. Takes the already-read secrets blob so the
/// sidecar spawn reads the secrets store only once.
pub fn build_sidecar_env(root: &Value) -> Option<String> {
    let blob = providers_from_root(root);
    if blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    serde_json::to_string(&blob).ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::secret_blob::tests::blob_over;
    use crate::secret_store::memory::MemoryBackend;
    use serde_json::json;

    /// A store that can't be read must never be treated as empty, or the next
    /// save would replace every other secret with this one.
    #[test]
    fn a_failed_read_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unreadable();
        let blob = blob_over(dir.path(), fake.clone());
        assert!(list_custom_provider_secret_status(&blob).is_err());
        assert!(
            set_custom_provider_secret(&blob, "p".into(), "apiKey".into(), "k".into()).is_err()
        );
        assert!(delete_custom_provider_secret(&blob, "p".into(), "apiKey".into()).is_err());
        assert!(delete_custom_provider_all_secrets(&blob, "p".into()).is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn set_list_and_delete_keep_sibling_keys_and_prune_empty_providers() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(r#"{"github_token":"t"}"#),
        );
        set_custom_provider_secret(&blob, "p".into(), "apiKey".into(), "k".into()).unwrap();
        set_custom_provider_secret(&blob, "p".into(), "header:X-A".into(), "v".into()).unwrap();
        let listed = list_custom_provider_secret_status(&blob).unwrap();
        assert_eq!(listed.len(), 1);
        assert!(listed[0].api_key_present);
        assert_eq!(listed[0].headers.get("X-A"), Some(&true));
        delete_custom_provider_secret(&blob, "p".into(), "apiKey".into()).unwrap();
        delete_custom_provider_secret(&blob, "p".into(), "header:X-A".into()).unwrap();
        assert_eq!(
            blob.read_root().unwrap(),
            json!({ "github_token": "t", "customProviders": {} })
        );
    }

    #[test]
    fn deleting_all_of_a_providers_secrets_leaves_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(
                r#"{"customProviders":{"p":{"apiKey":"k"},"q":{"apiKey":"j"}}}"#,
            ),
        );
        delete_custom_provider_all_secrets(&blob, "p".into()).unwrap();
        assert_eq!(
            blob.read_root().unwrap()["customProviders"],
            json!({ "q": { "apiKey": "j" } })
        );
    }

    #[test]
    fn reserved_and_unknown_slots_are_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::empty();
        let blob = blob_over(dir.path(), fake.clone());
        for slot in ["header:Cookie", "header:bad name", "header:", "password"] {
            assert!(
                set_custom_provider_secret(&blob, "p".into(), slot.into(), "v".into()).is_err(),
                "accepted {slot:?}"
            );
        }
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn the_status_serializes_with_the_camel_case_names_the_client_reads() {
        let status = CustomProviderSecretStatus {
            provider_id: "p".into(),
            api_key_present: true,
            headers: BTreeMap::new(),
        };
        assert_eq!(
            serde_json::to_value(status).unwrap(),
            json!({ "providerId": "p", "apiKeyPresent": true, "headers": {} })
        );
    }

    #[test]
    fn the_sidecar_env_is_the_subtree_or_nothing() {
        assert_eq!(build_sidecar_env(&json!({})), None);
        assert_eq!(build_sidecar_env(&json!({ "customProviders": {} })), None);
        assert_eq!(
            build_sidecar_env(&json!({ "customProviders": { "p": {} } })).as_deref(),
            Some(r#"{"p":{}}"#)
        );
    }
}
