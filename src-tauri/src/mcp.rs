//! Secret-only storage for user-configured MCP servers.
//!
//! The structural data (name, transport, url/command, args, header names) lives
//! in the sidecar's Postgres database. Only credential material lives here, in
//! the macOS Keychain: HTTP auth header values (for `http` transports) and
//! sensitive environment variables (for `stdio` transports). We nest under one
//! key in the shared secrets blob owned by [`crate::keychain`], holding a JSON
//! map: `{ "<server-id>": { "headers": { "<name>": string }, "env": { "<NAME>":
//! string } } }`. That subtree is injected into the sidecar at spawn time as the
//! `YARVIS_MCP_SECRETS` env var.

use std::collections::BTreeMap;

use serde::Serialize;
use serde_json::{Map, Value};

use crate::keychain;

/// Key under which MCP credentials nest inside the shared secrets blob. Sharing
/// that one Keychain item means MCP secrets don't add a separate authorization
/// prompt.
const MCP_SERVERS_KEY: &str = "mcpServers";

fn read_blob() -> Value {
    servers_from_root(&keychain::read_root())
}

fn servers_from_root(root: &Value) -> Value {
    root.get(MCP_SERVERS_KEY)
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()))
}

fn write_blob(value: &Value) -> Result<(), String> {
    let mut root = keychain::read_root();
    let obj = root
        .as_object_mut()
        .ok_or_else(|| "secrets store is not a JSON object".to_string())?;
    obj.insert(MCP_SERVERS_KEY.to_string(), value.clone());
    keychain::write_root(&root)
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

#[tauri::command]
pub fn list_mcp_secret_status() -> Vec<McpSecretStatus> {
    let blob = read_blob();
    let obj = blob.as_object().cloned().unwrap_or_default();
    let mut out = Vec::with_capacity(obj.len());
    for (id, entry) in obj {
        let entry_obj = entry.as_object().cloned().unwrap_or_default();
        out.push(McpSecretStatus {
            server_id: id,
            headers: presence_map(&entry_obj, "headers"),
            env: presence_map(&entry_obj, "env"),
        });
    }
    out
}

#[tauri::command]
pub fn set_mcp_secret(server_id: String, slot: String, value: String) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    if !blob.is_object() {
        blob = Value::Object(Map::new());
    }
    let server = server_entry(&mut blob, &server_id);
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
    write_blob(&blob)
}

fn entry_is_empty(entry: &Map<String, Value>) -> bool {
    let empty_field = |field: &str| {
        entry
            .get(field)
            .and_then(|v| v.as_object())
            .map(|o| o.is_empty())
            .unwrap_or(true)
    };
    empty_field("headers") && empty_field("env")
}

#[tauri::command]
pub fn delete_mcp_secret(server_id: String, slot: String) -> Result<(), String> {
    validate_slot(&slot)?;
    let mut blob = read_blob();
    let Some(root) = blob.as_object_mut() else {
        return Ok(());
    };
    let Some(server) = root.get_mut(&server_id).and_then(|v| v.as_object_mut()) else {
        return Ok(());
    };
    let (field, name) = if let Some(name) = slot.strip_prefix("header:") {
        ("headers", name)
    } else {
        ("env", slot.strip_prefix("env:").expect("validated above"))
    };
    if let Some(bucket) = server.get_mut(field).and_then(|v| v.as_object_mut()) {
        bucket.remove(name);
    }
    if entry_is_empty(server) {
        root.remove(&server_id);
    }
    write_blob(&blob)
}

/// Deletes every secret slot belonging to the given server id. Called from the
/// frontend when an MCP server is removed so no orphan credentials linger.
#[tauri::command]
pub fn delete_mcp_all_secrets(server_id: String) -> Result<(), String> {
    let mut blob = read_blob();
    let Some(root) = blob.as_object_mut() else {
        return Ok(());
    };
    if root.remove(&server_id).is_some() {
        write_blob(&blob)?;
    }
    Ok(())
}

/// Returns the raw JSON blob to inject as `YARVIS_MCP_SECRETS`, or `None` when
/// nothing is stored. Takes the already-read secrets blob so the sidecar spawn
/// reads the Keychain only once.
pub fn build_sidecar_env(root: &Value) -> Option<String> {
    let blob = servers_from_root(root);
    if blob.as_object().map(|o| o.is_empty()).unwrap_or(true) {
        return None;
    }
    serde_json::to_string(&blob).ok()
}
