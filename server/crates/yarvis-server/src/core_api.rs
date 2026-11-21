//! `POST /api/core/{command}`: the settings, secrets, sidecar and PTY commands.
//!
//! The body is the command's arguments as a JSON object with camelCase keys,
//! the shape the desktop app's commands took, so the UI's `core(cmd, args)`
//! sends what it always sent.
//! The response is the command's return value, or `204` when it has none. A
//! command's own error (a rejected value, a store that can't be read) comes
//! back as `400` with the message in `error`, since the UI shows it to the
//! user. Reads need `read`, driving a PTY needs `chat`, and anything that
//! writes a secret or a setting, or restarts the sidecar, needs `admin`.
//!
//! Every settings and secrets command runs on the blocking pool: a secrets
//! access can wait on a Keychain or 1Password prompt, and settings are a file
//! read and an atomic write. The PTY commands ([`crate::pty::core`]) put
//! their own blocking work there.

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{FromRequestParts, Path, Request, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

use crate::AppState;
use crate::auth::{Admin, Authed, Read, Scope, Terminal};
use crate::error::ApiError;
use crate::harness::AgentHarness;
use crate::settings::{BackendSwitchError, TextField};
use crate::{custom_providers, embeddings_secrets, mcp, pty};

/// Settings and secret arguments are small; a harness list is the largest.
const MAX_BODY_BYTES: usize = 256 * 1024;

/// Every command this route serves and the scope it needs. Only `read` and
/// `admin` appear: a command either only reads, or writes a secret or a
/// setting.
pub const COMMANDS: &[(&str, Scope)] = &[
    ("get_settings", Scope::Read),
    ("get_secret_status", Scope::Read),
    ("list_secret_status", Scope::Read),
    ("list_custom_provider_secret_status", Scope::Read),
    ("list_mcp_secret_status", Scope::Read),
    ("get_embeddings_secret_status", Scope::Read),
    ("list_agent_harness_secret_status", Scope::Read),
    ("set_secret", Scope::Admin),
    ("delete_secret", Scope::Admin),
    ("set_custom_provider_secret", Scope::Admin),
    ("delete_custom_provider_secret", Scope::Admin),
    ("delete_custom_provider_all_secrets", Scope::Admin),
    ("set_mcp_secret", Scope::Admin),
    ("delete_mcp_secret", Scope::Admin),
    ("delete_mcp_all_secrets", Scope::Admin),
    ("set_embeddings_secret", Scope::Admin),
    ("delete_embeddings_secret", Scope::Admin),
    ("set_max_pty_sessions", Scope::Admin),
    ("set_agent", Scope::Admin),
    ("set_agent_harnesses", Scope::Admin),
    ("set_agent_harness_secret", Scope::Admin),
    ("set_allowed_slash_commands", Scope::Admin),
    ("set_azure_devops_org_url", Scope::Admin),
    ("set_jira_base_url", Scope::Admin),
    ("set_jira_email", Scope::Admin),
    ("set_google_client_id", Scope::Admin),
    ("set_telegram_otp_window_minutes", Scope::Admin),
    ("set_color_theme", Scope::Admin),
    ("set_terminal_font_size", Scope::Admin),
    ("set_channel_messaging", Scope::Admin),
    ("set_attention_animation", Scope::Admin),
    ("set_secret_backend", Scope::Admin),
    ("restart_sidecar", Scope::Admin),
];

fn scope_of(command: &str) -> Option<Scope> {
    COMMANDS
        .iter()
        .find(|(name, _)| *name == command)
        .map(|(_, scope)| *scope)
}

pub async fn command(
    State(state): State<AppState>,
    Path(command): Path<String>,
    request: Request,
) -> Response {
    match handle(state, command, request).await {
        Ok(Some(value)) => Json(value).into_response(),
        Ok(None) => StatusCode::NO_CONTENT.into_response(),
        Err(e) => e.into_response(),
    }
}

async fn handle(
    state: AppState,
    command: String,
    request: Request,
) -> Result<Option<Value>, ApiError> {
    if let Some(scope) = pty::core::scope_of(&command) {
        return pty_command(state, scope, command, request).await;
    }
    let scope = scope_of(&command).ok_or_else(ApiError::not_found)?;
    let (mut parts, body) = request.into_parts();
    match scope {
        Scope::Read => {
            Authed::<Read>::from_request_parts(&mut parts, &state).await?;
        }
        Scope::Admin => {
            Authed::<Admin>::from_request_parts(&mut parts, &state).await?;
        }
        Scope::Chat | Scope::Terminal | Scope::Approve => {
            return Err(ApiError::internal(format!(
                "{command} is listed with a scope this route doesn't check"
            )));
        }
    }
    let args = read_args(body).await?;
    tokio::task::spawn_blocking(move || run(&state, &command, args))
        .await
        .map_err(ApiError::internal)?
}

/// The PTY commands ([`pty::core`]), which need `terminal` to drive a session
/// and run on the PTY manager rather than the blocking pool.
async fn pty_command(
    state: AppState,
    scope: Scope,
    command: String,
    request: Request,
) -> Result<Option<Value>, ApiError> {
    let (mut parts, body) = request.into_parts();
    match scope {
        Scope::Read => {
            Authed::<Read>::from_request_parts(&mut parts, &state).await?;
        }
        Scope::Terminal => {
            Authed::<Terminal>::from_request_parts(&mut parts, &state).await?;
        }
        Scope::Chat | Scope::Approve | Scope::Admin => {
            return Err(ApiError::internal(format!(
                "{command} is listed with a scope this route doesn't check"
            )));
        }
    }
    let args = read_args(body).await?;
    pty::core::run(&state.pty, &command, args).await
}

async fn read_args(body: Body) -> Result<Value, ApiError> {
    let bytes = to_bytes(body, MAX_BODY_BYTES)
        .await
        .map_err(|_| ApiError::bad_request("the request body is too large"))?;
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(json!({}));
    }
    serde_json::from_slice(&bytes)
        .map_err(|e| ApiError::bad_request("the body isn't valid JSON").with_detail(e.to_string()))
}

fn parse<T: DeserializeOwned>(args: Value) -> Result<T, ApiError> {
    serde_json::from_value(args)
        .map_err(|e| ApiError::bad_request("bad arguments").with_detail(e.to_string()))
}

/// A command's own failure, shown to the user as is.
fn failed(message: String) -> ApiError {
    ApiError::bad_request(message)
}

fn value(v: impl serde::Serialize) -> Result<Option<Value>, ApiError> {
    serde_json::to_value(v)
        .map(Some)
        .map_err(ApiError::internal)
}

#[derive(Deserialize)]
struct Key {
    key: String,
}

#[derive(Deserialize)]
struct KeyValue {
    key: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProviderSlot {
    provider_id: String,
    slot: String,
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provider {
    provider_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ServerSlot {
    server_id: String,
    slot: String,
    value: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Server {
    server_id: String,
}

#[derive(Deserialize)]
struct Slot {
    slot: String,
    value: Option<String>,
}

#[derive(Deserialize)]
struct Optional<T> {
    value: Option<T>,
}

#[derive(Deserialize)]
struct Agent {
    name: Option<String>,
    command: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Harnesses {
    harnesses: Vec<AgentHarness>,
    default_harness: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct HarnessSecret {
    harness_id: String,
    key: String,
    value: Option<String>,
}

#[derive(Deserialize)]
struct Commands {
    commands: Vec<String>,
}

#[derive(Deserialize)]
struct Enabled {
    enabled: bool,
}

#[derive(Deserialize)]
struct Backend {
    backend: String,
    vault: Option<String>,
    item: Option<String>,
}

/// The slot's value for a `set_*` command. The UI always sends one; a missing
/// one is a malformed call rather than a delete, which has its own command.
fn required(value: Option<String>) -> Result<String, ApiError> {
    value.ok_or_else(|| ApiError::bad_request("bad arguments").with_detail("missing `value`"))
}

fn run(state: &AppState, command: &str, args: Value) -> Result<Option<Value>, ApiError> {
    let secrets = &state.secrets;
    let settings = &state.settings;
    let text = |field: TextField, args: Value| -> Result<Option<Value>, ApiError> {
        let Optional::<String> { value: v } = parse(args)?;
        settings.set_text_field(field, v).map_err(failed)?;
        value(settings.view())
    };
    match command {
        "get_secret_status" => {
            let Key { key } = parse(args)?;
            value(secrets.get_secret_status(&key).map_err(failed)?)
        }
        "list_secret_status" => value(secrets.list_secret_status().map_err(failed)?),
        "set_secret" => {
            let KeyValue { key, value: v } = parse(args)?;
            secrets.set_secret(&key, v).map_err(failed)?;
            Ok(None)
        }
        "delete_secret" => {
            let Key { key } = parse(args)?;
            secrets.delete_secret(&key).map_err(failed)?;
            Ok(None)
        }

        "list_custom_provider_secret_status" => {
            value(custom_providers::list_custom_provider_secret_status(secrets).map_err(failed)?)
        }
        "set_custom_provider_secret" => {
            let a: ProviderSlot = parse(args)?;
            custom_providers::set_custom_provider_secret(
                secrets,
                a.provider_id,
                a.slot,
                required(a.value)?,
            )
            .map_err(failed)?;
            Ok(None)
        }
        "delete_custom_provider_secret" => {
            let a: ProviderSlot = parse(args)?;
            custom_providers::delete_custom_provider_secret(secrets, a.provider_id, a.slot)
                .map_err(failed)?;
            Ok(None)
        }
        "delete_custom_provider_all_secrets" => {
            let Provider { provider_id } = parse(args)?;
            custom_providers::delete_custom_provider_all_secrets(secrets, provider_id)
                .map_err(failed)?;
            Ok(None)
        }

        "list_mcp_secret_status" => value(mcp::list_mcp_secret_status(secrets).map_err(failed)?),
        "set_mcp_secret" => {
            let a: ServerSlot = parse(args)?;
            mcp::set_mcp_secret(secrets, a.server_id, a.slot, required(a.value)?)
                .map_err(failed)?;
            Ok(None)
        }
        "delete_mcp_secret" => {
            let a: ServerSlot = parse(args)?;
            mcp::delete_mcp_secret(secrets, a.server_id, a.slot).map_err(failed)?;
            Ok(None)
        }
        "delete_mcp_all_secrets" => {
            let Server { server_id } = parse(args)?;
            mcp::delete_mcp_all_secrets(secrets, server_id).map_err(failed)?;
            Ok(None)
        }

        "get_embeddings_secret_status" => {
            value(embeddings_secrets::get_embeddings_secret_status(secrets).map_err(failed)?)
        }
        "set_embeddings_secret" => {
            let Slot { slot, value: v } = parse(args)?;
            embeddings_secrets::set_embeddings_secret(secrets, slot, required(v)?)
                .map_err(failed)?;
            Ok(None)
        }
        "delete_embeddings_secret" => {
            let Slot { slot, .. } = parse(args)?;
            embeddings_secrets::delete_embeddings_secret(secrets, slot).map_err(failed)?;
            Ok(None)
        }

        "get_settings" => value(settings.view()),
        "set_max_pty_sessions" => {
            let Optional::<usize> { value: v } = parse(args)?;
            settings.set_max_pty_sessions(v).map_err(failed)?;
            value(settings.view())
        }
        "set_agent" => {
            let Agent { name, command } = parse(args)?;
            settings.set_agent(name, command).map_err(failed)?;
            value(settings.view())
        }
        "set_agent_harnesses" => {
            let Harnesses {
                harnesses,
                default_harness,
            } = parse(args)?;
            settings
                .set_agent_harnesses(secrets, harnesses, default_harness)
                .map_err(failed)?;
            value(settings.view())
        }
        "list_agent_harness_secret_status" => value(
            settings
                .list_agent_harness_secret_status(secrets)
                .map_err(failed)?,
        ),
        "set_agent_harness_secret" => {
            let HarnessSecret {
                harness_id,
                key,
                value: v,
            } = parse(args)?;
            settings
                .set_agent_harness_secret(secrets, &harness_id, &key, v)
                .map_err(failed)?;
            Ok(None)
        }
        "set_allowed_slash_commands" => {
            let Commands { commands } = parse(args)?;
            settings
                .set_allowed_slash_commands(commands)
                .map_err(failed)?;
            value(settings.view())
        }
        "set_azure_devops_org_url" => text(TextField::AzureDevopsOrgUrl, args),
        "set_jira_base_url" => text(TextField::JiraBaseUrl, args),
        "set_jira_email" => text(TextField::JiraEmail, args),
        "set_google_client_id" => text(TextField::GoogleClientId, args),
        "set_color_theme" => text(TextField::ColorTheme, args),
        "set_telegram_otp_window_minutes" => {
            let Optional::<u32> { value: v } = parse(args)?;
            settings
                .set_telegram_otp_window_minutes(v)
                .map_err(failed)?;
            value(settings.view())
        }
        "set_terminal_font_size" => {
            let Optional::<u32> { value: v } = parse(args)?;
            settings.set_terminal_font_size(v).map_err(failed)?;
            value(settings.view())
        }
        "set_channel_messaging" => {
            let Enabled { enabled } = parse(args)?;
            settings.set_channel_messaging(enabled).map_err(failed)?;
            value(settings.view())
        }
        "set_attention_animation" => {
            let Optional::<bool> { value: v } = parse(args)?;
            settings.set_attention_animation(v).map_err(failed)?;
            value(settings.view())
        }
        "set_secret_backend" => {
            let Backend {
                backend,
                vault,
                item,
            } = parse(args)?;
            let copied = settings
                .set_secret_backend(secrets, state.config.secrets.backend, &backend, vault, item)
                .map_err(|e| match e {
                    BackendSwitchError::NotConfigured => ApiError::conflict(e.to_string()),
                    BackendSwitchError::Invalid(m) | BackendSwitchError::Failed(m) => failed(m),
                })?;
            value(json!({ "settings": settings.view(), "copied": copied }))
        }

        "restart_sidecar" => {
            state.sidecar.restart();
            Ok(None)
        }
        _ => Err(ApiError::not_found()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A command that only reads is named `get_` or `list_`, and everything
    /// else writes, so a write listed as a read stands out here.
    #[test]
    fn only_get_and_list_commands_are_reads() {
        for (name, scope) in COMMANDS {
            let reads = name.starts_with("get_") || name.starts_with("list_");
            let expected = if reads { Scope::Read } else { Scope::Admin };
            assert_eq!(*scope, expected, "{name}");
        }
    }

    /// The commands that make no sense on a server, or belong to another
    /// module, are not served here.
    #[test]
    fn client_local_and_dropped_commands_are_not_served() {
        for command in [
            "get_sidecar_info",
            "get_sidecar_log_path",
            "focus_main_window",
            "release_alarm",
            "pty_spawn",
        ] {
            assert_eq!(scope_of(command), None, "{command}");
        }
    }
}
