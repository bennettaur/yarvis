//! Secret-only storage for user-configured MCP servers.
//!
//! The structural data (name, transport, url/command, args, header names) lives
//! in the sidecar's Postgres database. Only credential material lives here, in
//! the secrets store: HTTP auth header values (for `http` transports),
//! sensitive environment variables (for `stdio` transports), and the OAuth
//! client registration and tokens for servers that authorize rather than carry a
//! hand-entered token. We nest under one key in the shared secrets blob owned by
//! [`crate::secret_blob`], holding a JSON map: `{ "<server-id>": { "headers": {
//! "<name>": string }, "env": { "<NAME>": string }, "oauth": { … } } }`. That
//! subtree is injected into the sidecar at spawn time as the
//! `YARVIS_MCP_SECRETS` env var.
//!
//! The header and env values are written by the client through the functions
//! below.
//! The `oauth` subtree is the exception: tokens refresh on the authorization
//! server's schedule while the server runs, so the sidecar writes it through
//! [`store_oauth`], reached over the control channel. That method can only
//! address this one subtree.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::secret_blob::SecretBlob;

/// Key under which MCP credentials nest inside the shared secrets blob. Sharing
/// that one item means MCP secrets don't add a separate authorization
/// prompt.
const MCP_SERVERS_KEY: &str = "mcpServers";

fn read_blob(blob: &SecretBlob) -> Result<Value, String> {
    Ok(servers_from_root(&blob.read_root()?))
}

fn servers_from_root(root: &Value) -> Value {
    root.get(MCP_SERVERS_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn update_blob(
    blob: &SecretBlob,
    edit: impl FnOnce(&mut Value) -> Result<bool, String>,
) -> Result<(), String> {
    blob.update_subtree(MCP_SERVERS_KEY, edit)
}

fn server_entry<'a>(blob: &'a mut Value, id: &str) -> &'a mut Map<String, Value> {
    let obj = blob.as_object_mut().expect("root is always an object");
    if !obj.contains_key(id) {
        obj.insert(id.to_string(), Value::Object(Map::new()));
    }
    obj.get_mut(id)
        .expect("just inserted")
        .as_object_mut()
        .expect("server entries are objects")
}

/// Header names a server config must not override on outbound requests. Kept in
/// lockstep with the sidecar's RESERVED_HEADER_NAMES set.
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
const MAX_ENV_NAME_LEN: usize = 256;

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

/// Environment variable names follow the conventional POSIX shell charset:
/// a letter or underscore, then letters/digits/underscores.
fn validate_env_name(name: &str) -> Result<(), String> {
    if name.is_empty() {
        return Err("env name is empty".to_string());
    }
    if name.len() > MAX_ENV_NAME_LEN {
        return Err(format!("env name exceeds {MAX_ENV_NAME_LEN} characters"));
    }
    let mut chars = name.chars();
    let first = chars.next().expect("non-empty checked above");
    if !(first.is_ascii_alphabetic() || first == '_') {
        return Err("env name must start with a letter or underscore".to_string());
    }
    if !name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
        return Err("env name must contain only letters, digits, and underscores".to_string());
    }
    Ok(())
}

/// A secret "slot" is either `header:<name>` (HTTP transports) or `env:<NAME>`
/// (stdio transports).
fn validate_slot(slot: &str) -> Result<(), String> {
    if let Some(name) = slot.strip_prefix("header:") {
        return validate_header_name(name);
    }
    if let Some(name) = slot.strip_prefix("env:") {
        return validate_env_name(name);
    }
    Err(format!("unknown secret slot: {slot}"))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpSecretStatus {
    pub server_id: String,
    /// Header name → whether a value is stored.
    pub headers: BTreeMap<String, bool>,
    /// Env var name → whether a value is stored.
    pub env: BTreeMap<String, bool>,
}

fn presence_map(entry: &Map<String, Value>, field: &str) -> BTreeMap<String, bool> {
    let mut out = BTreeMap::new();
    if let Some(obj) = entry.get(field).and_then(|v| v.as_object()) {
        for (name, value) in obj {
            let present = value.as_str().map(|s| !s.is_empty()).unwrap_or(false);
            out.insert(name.clone(), present);
        }
    }
    out
}

pub fn list_mcp_secret_status(blob: &SecretBlob) -> Result<Vec<McpSecretStatus>, String> {
    let secrets = read_blob(blob)?;
    let obj = secrets.as_object().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(obj.len());
    for (id, entry) in obj {
        let entry_obj = entry.as_object().cloned().unwrap_or_default();
        out.push(McpSecretStatus {
            server_id: id,
            headers: presence_map(&entry_obj, "headers"),
            env: presence_map(&entry_obj, "env"),
        });
    }
    Ok(out)
}

pub fn set_mcp_secret(
    blob: &SecretBlob,
    server_id: String,
    slot: String,
    value: String,
) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let server = server_entry(subtree, &server_id);
        let (field, name) = if let Some(name) = slot.strip_prefix("header:") {
            ("headers", name)
        } else {
            ("env", slot.strip_prefix("env:").expect("validated above"))
        };
        let bucket = server
            .entry(field)
            .or_insert_with(|| Value::Object(Map::new()));
        if !bucket.is_object() {
            *bucket = Value::Object(Map::new());
        }
        bucket
            .as_object_mut()
            .expect("just ensured")
            .insert(name.to_string(), Value::String(value));
        Ok(true)
    })
}

fn entry_is_empty(entry: &Map<String, Value>) -> bool {
    let empty_field = |field: &str| {
        entry
            .get(field)
            .and_then(|v| v.as_object())
            .map(|o| o.is_empty())
            .unwrap_or(true)
    };
    empty_field("headers") && empty_field("env") && empty_field("oauth")
}

/// Server ids are the sidecar's UUID primary keys. Reject anything else so a
/// caller can't reach a sibling key in the secrets blob through this one method.
fn validate_server_id(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 64
        && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    if ok {
        Ok(())
    } else {
        Err("invalid serverId".to_string())
    }
}

/// Stores (or, given `None`, forgets) a server's OAuth client registration and
/// tokens. Called by the sidecar over the control channel, which is why the id
/// is validated here rather than trusted from the caller.
pub fn store_oauth(blob: &SecretBlob, server_id: &str, oauth: Option<Value>) -> Result<(), String> {
    validate_server_id(server_id)?;
    if oauth.as_ref().is_some_and(|value| !value.is_object()) {
        return Err("oauth must be a JSON object".to_string());
    }
    update_blob(blob, |subtree| {
        if let Some(value) = oauth {
            server_entry(subtree, server_id).insert("oauth".to_string(), value);
            return Ok(true);
        }
        let root = subtree.as_object_mut().expect("subtree is an object");
        let Some(server) = root.get_mut(server_id).and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        server.remove("oauth");
        if entry_is_empty(server) {
            root.remove(server_id);
        }
        Ok(true)
    })
}

pub fn delete_mcp_secret(blob: &SecretBlob, server_id: String, slot: String) -> Result<(), String> {
    validate_slot(&slot)?;
    update_blob(blob, |subtree| {
        let root = subtree.as_object_mut().expect("subtree is an object");
        let Some(server) = root.get_mut(&server_id).and_then(|v| v.as_object_mut()) else {
            return Ok(false);
        };
        let (field, name) = if let Some(name) = slot.strip_prefix("header:") {
            ("headers", name)
        } else {
            ("env", slot.strip_prefix("env:").expect("validated above"))
        };
        let removed = server
            .get_mut(field)
            .and_then(|v| v.as_object_mut())
            .is_some_and(|bucket| bucket.remove(name).is_some());
        let pruned = entry_is_empty(server) && root.remove(&server_id).is_some();
        Ok(removed || pruned)
    })
}

/// Deletes every secret slot belonging to the given server id. Called by the
/// client when an MCP server is removed so no orphan credentials linger.
pub fn delete_mcp_all_secrets(blob: &SecretBlob, server_id: String) -> Result<(), String> {
    update_blob(blob, |subtree| {
        let root = subtree.as_object_mut().expect("subtree is an object");
        Ok(root.remove(&server_id).is_some())
    })
}

/// Returns the raw JSON blob to inject as `YARVIS_MCP_SECRETS`, or `None` when
/// nothing is stored. Takes the already-read secrets blob so the sidecar spawn
/// reads the secrets store only once.
pub fn build_sidecar_env(root: &Value) -> Option<String> {
    let blob = servers_from_root(root);
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

    #[test]
    fn a_uuid_server_id_is_accepted() {
        assert!(validate_server_id("11111111-1111-1111-1111-111111111111").is_ok());
    }

    #[test]
    fn a_server_id_cannot_smuggle_a_path_or_separator() {
        // The sidecar reaches `store_oauth` over the control channel, so this is
        // what keeps it inside its own entry of the secrets blob.
        for bad in ["", "../database_url", "a b", "id\"", "a.b", "a/b"] {
            assert!(validate_server_id(bad).is_err(), "accepted {bad:?}");
        }
    }

    #[test]
    fn an_entry_holding_only_oauth_is_not_empty() {
        let entry: Map<String, Value> =
            serde_json::from_str(r#"{"oauth":{"clientId":"cl_1"}}"#).unwrap();
        assert!(!entry_is_empty(&entry));
    }

    #[test]
    fn an_entry_with_every_bucket_emptied_is_empty() {
        let entry: Map<String, Value> =
            serde_json::from_str(r#"{"headers":{},"env":{},"oauth":{}}"#).unwrap();
        assert!(entry_is_empty(&entry));
    }

    /// A store that can't be read must never be treated as empty, or the next
    /// save would replace every other secret with this one.
    #[test]
    fn a_failed_read_writes_nothing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::unreadable();
        let blob = blob_over(dir.path(), fake.clone());
        assert!(list_mcp_secret_status(&blob).is_err());
        assert!(set_mcp_secret(&blob, "id-1".into(), "header:X-A".into(), "v".into()).is_err());
        assert!(delete_mcp_secret(&blob, "id-1".into(), "env:A".into()).is_err());
        assert!(delete_mcp_all_secrets(&blob, "id-1".into()).is_err());
        assert!(store_oauth(&blob, "id-1", Some(json!({ "a": 1 }))).is_err());
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn set_list_and_delete_keep_sibling_keys_and_prune_empty_entries() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(
            dir.path(),
            MemoryBackend::holding(r#"{"github_token":"t"}"#),
        );
        set_mcp_secret(&blob, "id-1".into(), "header:X-A".into(), "v".into()).unwrap();
        set_mcp_secret(&blob, "id-1".into(), "env:TOKEN".into(), "w".into()).unwrap();
        let listed = list_mcp_secret_status(&blob).unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].headers.get("X-A"), Some(&true));
        assert_eq!(listed[0].env.get("TOKEN"), Some(&true));
        delete_mcp_secret(&blob, "id-1".into(), "header:X-A".into()).unwrap();
        delete_mcp_secret(&blob, "id-1".into(), "env:TOKEN".into()).unwrap();
        assert_eq!(
            blob.read_root().unwrap(),
            json!({ "github_token": "t", "mcpServers": {} })
        );
    }

    /// Removing an MCP server drops its whole entry, OAuth included, so none
    /// of its credentials reach the next sidecar.
    #[test]
    fn deleting_all_of_a_servers_secrets_leaves_the_others() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::empty();
        let blob = blob_over(dir.path(), fake.clone());
        set_mcp_secret(&blob, "gone".into(), "header:X-A".into(), "v".into()).unwrap();
        set_mcp_secret(&blob, "gone".into(), "env:TOKEN".into(), "w".into()).unwrap();
        store_oauth(&blob, "gone", Some(json!({ "access_token": "at" }))).unwrap();
        set_mcp_secret(&blob, "kept".into(), "env:TOKEN".into(), "k".into()).unwrap();

        delete_mcp_all_secrets(&blob, "gone".into()).unwrap();

        let root = blob.read_root().unwrap();
        assert_eq!(
            root["mcpServers"],
            json!({ "kept": { "env": { "TOKEN": "k" } } })
        );
        assert_eq!(
            build_sidecar_env(&root).as_deref(),
            Some(r#"{"kept":{"env":{"TOKEN":"k"}}}"#)
        );
        let writes = fake.writes().len();
        delete_mcp_all_secrets(&blob, "never-there".into()).unwrap();
        assert_eq!(fake.writes().len(), writes, "a no-op delete writes nothing");
    }

    #[test]
    fn reserved_and_malformed_slots_are_refused_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let fake = MemoryBackend::empty();
        let blob = blob_over(dir.path(), fake.clone());
        for slot in ["header:Authorization", "header:", "env:1BAD", "other"] {
            assert!(set_mcp_secret(&blob, "id-1".into(), slot.into(), "v".into()).is_err());
        }
        assert!(fake.writes().is_empty());
    }

    #[test]
    fn oauth_is_stored_and_forgotten_through_its_own_entry() {
        let dir = tempfile::tempdir().unwrap();
        let blob = blob_over(dir.path(), MemoryBackend::empty());
        store_oauth(&blob, "id-1", Some(json!({ "clientId": "c" }))).unwrap();
        assert!(store_oauth(&blob, "id-1", Some(json!("not an object"))).is_err());
        assert!(store_oauth(&blob, "../x", None).is_err());
        assert_eq!(
            blob.read_root().unwrap()["mcpServers"]["id-1"]["oauth"],
            json!({ "clientId": "c" })
        );
        store_oauth(&blob, "id-1", None).unwrap();
        assert_eq!(blob.read_root().unwrap()["mcpServers"], json!({}));
    }

    #[test]
    fn the_sidecar_env_is_the_subtree_or_nothing() {
        assert_eq!(build_sidecar_env(&json!({})), None);
        assert_eq!(build_sidecar_env(&json!({ "mcpServers": {} })), None);
        assert_eq!(
            build_sidecar_env(&json!({ "mcpServers": { "a": {} } })).as_deref(),
            Some(r#"{"a":{}}"#)
        );
    }
}
