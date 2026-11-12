//! Agent harnesses: the named agent programs a workspace session can run.
//!
//! The built-in harness (id [`BUILTIN_HARNESS_ID`]) is the long-standing single
//! agent: its name and command are `agentName`/`agentCommand` in
//! `~/.yarvis/settings.json`, with the `YARVIS_CLAUDE_COMMAND` override. Every
//! other harness is an entry in `agentHarnesses`, and `defaultAgentHarness`
//! picks which one a launch gets when it names none.
//!
//! Harnesses are written only from the webview, like the agent command, because
//! a harness's command is typed into a shell. A caller on the control channel
//! can pick a harness by id but never supply a command of its own.
//!
//! A harness's environment comes in two halves. Plain variables sit in the
//! settings file. Variables named in `secretEnv` hold credentials (a second
//! Claude Code pointed at another provider needs an API key), so their values
//! live in the secret store under [`SECRET_ENV_SUBTREE`] and are read only when
//! a session using that harness starts.

use std::collections::BTreeMap;
use std::ffi::OsStr;
use std::path::Path;

use serde::{Deserialize, Deserializer, Serialize};
use serde_json::Value;

/// Id of the harness built from `agentName`/`agentCommand`.
pub const BUILTIN_HARNESS_ID: &str = "claude";

/// Secret-store subtree holding each harness's secret env values, keyed by
/// harness id and then by variable name.
pub const SECRET_ENV_SUBTREE: &str = "agent_harness_env";

/// Placeholder in a harness's `promptArgs` that the quoted instruction replaces.
pub const PROMPT_PLACEHOLDER: &str = "{prompt}";

/// Characters refused in `promptArgs`. The instruction is quoted before it
/// replaces `{prompt}`, so a placeholder the user wrapped in quotes of their
/// own (`'{prompt}'`, `"{prompt}"`) would close that quoting and leave the
/// instruction for the shell to expand.
const PROMPT_ARGS_REFUSED: [char; 5] = ['\'', '"', '`', '$', '\\'];

fn prompt_args_are_safe(args: &str) -> bool {
    args.matches(PROMPT_PLACEHOLDER).count() == 1
        && !args.chars().any(|c| PROMPT_ARGS_REFUSED.contains(&c))
}

/// Longest harness id. Ids reach URLs and env vars, so they stay short.
const MAX_ID_CHARS: usize = 40;
/// Longest harness name. It is a tab title.
const MAX_NAME_CHARS: usize = 60;
/// Most harnesses a user can configure; a bound on what a hand edit can load.
pub const MAX_HARNESSES: usize = 32;

/// The agent program a harness runs. Decides which Claude Code-only launch
/// options apply, and the default way an instruction is passed.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum HarnessKind {
    ClaudeCode,
    Pi,
    Opencode,
    #[default]
    Custom,
}

impl HarnessKind {
    /// Reads a stored kind. Anything unknown is `Custom`, so a hand edit or a
    /// kind written by a newer build launches as a plain command instead of
    /// failing the settings parse.
    fn parse(value: &str) -> Self {
        match value {
            "claude-code" => Self::ClaudeCode,
            "pi" => Self::Pi,
            "opencode" => Self::Opencode,
            _ => Self::Custom,
        }
    }

    /// How an instruction is passed when the harness sets no `promptArgs`.
    /// `None` appends it as a positional argument, which Claude Code and Pi
    /// both read as the first prompt of an interactive session. OpenCode's TUI
    /// takes it through `--prompt`.
    fn default_prompt_args(self) -> Option<&'static str> {
        match self {
            Self::Opencode => Some("--prompt {prompt}"),
            Self::ClaudeCode | Self::Pi | Self::Custom => None,
        }
    }
}

impl<'de> Deserialize<'de> for HarnessKind {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let raw = String::deserialize(deserializer)?;
        Ok(Self::parse(&raw))
    }
}

/// One configured harness, as stored in `agentHarnesses`. Every field has a
/// default so a hand-edited entry missing one still parses; `validate` is what
/// rejects an incomplete one on save, and `resolve` skips it on read.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct AgentHarness {
    pub id: String,
    pub name: String,
    pub kind: HarnessKind,
    pub command: String,
    /// How an instruction is passed, e.g. `--prompt {prompt}`. Blank means the
    /// kind's default.
    pub prompt_args: Option<String>,
    /// Plain environment variables set for the session.
    pub env: BTreeMap<String, String>,
    /// Names of variables whose values are in the secret store.
    pub secret_env: Vec<String>,
}

/// Parses `agentHarnesses` one entry at a time, dropping any entry that isn't
/// an object of the right shape. Without this, one bad entry in a hand-edited
/// file would fail the whole `Settings` parse, which reads as empty settings
/// and is then written back over the user's file on the next save.
pub fn deserialize_lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Vec<AgentHarness>>, D::Error> {
    let raw = Option::<Value>::deserialize(deserializer)?;
    let Some(Value::Array(entries)) = raw else {
        return Ok(None);
    };
    let harnesses: Vec<AgentHarness> = entries
        .into_iter()
        .filter_map(|entry| serde_json::from_value(entry).ok())
        .take(MAX_HARNESSES)
        .collect();
    Ok(Some(harnesses))
}

/// Parses `defaultAgentHarness`, reading anything but a string as unset, for
/// the same reason as [`deserialize_lenient`].
pub fn deserialize_default_lenient<'de, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<String>, D::Error> {
    Ok(match Option::<Value>::deserialize(deserializer)? {
        Some(Value::String(id)) => Some(id),
        _ => None,
    })
}

/// A harness ready to launch: what `spawn_claude_session` needs.
#[derive(Clone, Debug, PartialEq)]
pub struct ResolvedHarness {
    pub id: String,
    pub name: String,
    pub kind: HarnessKind,
    /// The command line, control characters stripped and trimmed.
    pub command: String,
    pub prompt_args: Option<String>,
    pub env: Vec<(String, String)>,
    pub secret_env: Vec<String>,
}

impl ResolvedHarness {
    /// What the foreground check compares the session's process to.
    pub fn program(&self) -> Option<String> {
        program_of(&self.command)
    }
}

/// The executable a command line runs, past any leading `VAR=value`
/// assignments.
fn program_of(command: &str) -> Option<String> {
    command
        .split_whitespace()
        .find(|word| !word.contains('='))
        .map(str::to_string)
}

/// True when a command launches Claude Code, judged by its program's file name.
/// Decides the built-in harness's kind, since `agentCommand` carries none.
fn runs_claude_code(command: &str) -> bool {
    program_of(command)
        .is_some_and(|program| Path::new(&program).file_name() == Some(OsStr::new("claude")))
}

fn strip_control(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_control())
        .collect::<String>()
        .trim()
        .to_string()
}

fn non_blank(value: Option<&str>) -> Option<String> {
    value.map(strip_control).filter(|s| !s.is_empty())
}

/// The built-in harness from the agent name and command already resolved by
/// `pty` (env override, then setting, then default).
pub fn builtin(name: String, command: String) -> ResolvedHarness {
    let kind = if runs_claude_code(&command) {
        HarnessKind::ClaudeCode
    } else {
        HarnessKind::Custom
    };
    ResolvedHarness {
        id: BUILTIN_HARNESS_ID.to_string(),
        name,
        kind,
        command,
        prompt_args: None,
        env: Vec::new(),
        secret_env: Vec::new(),
    }
}

/// Turns a stored harness into a launchable one, or `None` when the entry is
/// unusable (a hand edit left its id or command blank, or gave it a reserved
/// variable). Re-checks what `validate` checked, since the file is
/// hand-editable.
fn resolve_stored(harness: &AgentHarness) -> Option<ResolvedHarness> {
    if !is_valid_id(&harness.id) || harness.id == BUILTIN_HARNESS_ID {
        return None;
    }
    let command = non_blank(Some(&harness.command))?;
    let name = non_blank(Some(&harness.name)).unwrap_or_else(|| harness.id.clone());
    let env: Vec<(String, String)> = harness
        .env
        .iter()
        .filter(|(key, _)| is_valid_env_name(key))
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    let secret_env: Vec<String> = harness
        .secret_env
        .iter()
        .filter(|key| is_valid_env_name(key))
        .cloned()
        .collect();
    let prompt_args = non_blank(harness.prompt_args.as_deref())
        .filter(|args| prompt_args_are_safe(args))
        .or_else(|| harness.kind.default_prompt_args().map(str::to_string));
    Some(ResolvedHarness {
        id: harness.id.clone(),
        name,
        kind: harness.kind,
        command,
        prompt_args,
        env,
        secret_env,
    })
}

/// Every launchable harness, the built-in one first.
pub fn all(builtin: ResolvedHarness, stored: &[AgentHarness]) -> Vec<ResolvedHarness> {
    std::iter::once(builtin)
        .chain(stored.iter().filter_map(resolve_stored))
        .collect()
}

/// Picks the harness for a launch. An explicit `requested` id must name a
/// configured harness: launching a different agent than the caller asked for
/// would be worse than refusing. With no id, the configured default is used,
/// falling back to the built-in one when that default no longer exists.
pub fn resolve(
    builtin: ResolvedHarness,
    stored: &[AgentHarness],
    default_id: Option<&str>,
    requested: Option<&str>,
) -> Result<ResolvedHarness, String> {
    let harnesses = all(builtin, stored);
    let find = |id: &str| harnesses.iter().find(|h| h.id == id).cloned();
    match requested.map(str::trim).filter(|id| !id.is_empty()) {
        Some(id) => find(id).ok_or_else(|| format!("no agent harness named \"{id}\"")),
        None => Ok(default_id
            .and_then(find)
            .unwrap_or_else(|| harnesses[0].clone())),
    }
}

/// The id of the harness a launch with no id would get, given the stored
/// `configured` default.
pub fn default_id(stored: &[AgentHarness], configured: Option<&str>) -> String {
    configured
        .filter(|id| {
            *id == BUILTIN_HARNESS_ID
                || stored
                    .iter()
                    .any(|h| h.id == *id && resolve_stored(h).is_some())
        })
        .unwrap_or(BUILTIN_HARNESS_ID)
        .to_string()
}

fn is_valid_id(id: &str) -> bool {
    let mut chars = id.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    id.len() <= MAX_ID_CHARS
        && (first.is_ascii_lowercase() || first.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
}

/// A portable environment variable name that isn't one the core sets itself.
/// `YARVIS_*` carries the session's tokens and key: a harness that set them
/// would at best break the session's registration and at worst point it at
/// another terminal's. `TERM` is the core's, set for the PTY it opens.
fn is_valid_env_name(name: &str) -> bool {
    let mut chars = name.chars();
    let Some(first) = chars.next() else {
        return false;
    };
    (first.is_ascii_alphabetic() || first == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && !name.to_ascii_uppercase().starts_with("YARVIS_")
        && name != "TERM"
}

/// Checks a harness list and default before they are saved, so the user sees
/// why a save failed rather than having an entry silently skipped later.
pub fn validate(harnesses: &[AgentHarness], default_id: Option<&str>) -> Result<(), String> {
    if harnesses.len() > MAX_HARNESSES {
        return Err(format!(
            "at most {MAX_HARNESSES} harnesses can be configured"
        ));
    }
    let mut seen: Vec<&str> = Vec::new();
    for harness in harnesses {
        let label = if harness.name.trim().is_empty() {
            harness.id.as_str()
        } else {
            harness.name.trim()
        };
        if !is_valid_id(&harness.id) {
            return Err(format!(
                "\"{}\" is not a valid harness id: use lower-case letters, digits and dashes, at most {MAX_ID_CHARS} characters",
                harness.id
            ));
        }
        if harness.id == BUILTIN_HARNESS_ID {
            return Err(format!(
                "the id \"{BUILTIN_HARNESS_ID}\" belongs to the built-in agent"
            ));
        }
        if seen.contains(&harness.id.as_str()) {
            return Err(format!("two harnesses share the id \"{}\"", harness.id));
        }
        seen.push(&harness.id);
        if harness.name.trim().is_empty() {
            return Err(format!("harness \"{}\" needs a name", harness.id));
        }
        if harness.name.chars().count() > MAX_NAME_CHARS {
            return Err(format!(
                "harness \"{label}\" has a name longer than {MAX_NAME_CHARS} characters"
            ));
        }
        if harness.command.trim().is_empty() {
            return Err(format!("harness \"{label}\" needs a command"));
        }
        // The command and prompt arguments are typed into an interactive shell,
        // where a newline or 0x03/0x15 would end the line early; see
        // `pty::is_unsafe_name_char`.
        let typed = [
            Some(harness.name.as_str()),
            Some(harness.command.as_str()),
            harness.prompt_args.as_deref(),
        ];
        if typed
            .iter()
            .flatten()
            .any(|s| s.chars().any(char::is_control))
        {
            return Err(format!(
                "harness \"{label}\" must not contain control characters"
            ));
        }
        if let Some(args) = harness
            .prompt_args
            .as_deref()
            .filter(|a| !a.trim().is_empty())
        {
            if args.matches(PROMPT_PLACEHOLDER).count() != 1 {
                return Err(format!(
                    "harness \"{label}\"'s prompt arguments must contain {PROMPT_PLACEHOLDER} exactly once"
                ));
            }
            if !prompt_args_are_safe(args) {
                return Err(format!(
                    "harness \"{label}\"'s prompt arguments may not contain quotes, $, ` or \\; {PROMPT_PLACEHOLDER} is quoted for you"
                ));
            }
        }
        for key in harness.env.keys().chain(harness.secret_env.iter()) {
            if !is_valid_env_name(key) {
                return Err(format!(
                    "harness \"{label}\" sets \"{key}\", which is not a variable name a harness may set"
                ));
            }
        }
        if let Some((_, key)) = harness
            .secret_env
            .iter()
            .enumerate()
            .find(|(i, key)| harness.secret_env[..*i].contains(key))
        {
            return Err(format!(
                "harness \"{label}\" lists the secret variable \"{key}\" twice"
            ));
        }
        if let Some(key) = harness
            .secret_env
            .iter()
            .find(|key| harness.env.contains_key(*key))
        {
            return Err(format!(
                "harness \"{label}\" sets \"{key}\" both as a plain and a secret variable"
            ));
        }
    }
    if let Some(id) = default_id {
        if id != BUILTIN_HARNESS_ID && !harnesses.iter().any(|h| h.id == id) {
            return Err(format!("the default harness \"{id}\" is not configured"));
        }
    }
    Ok(())
}

/// Reads one harness's secret env values out of an already-read secrets blob.
/// A declared variable with no stored value is an error: launching without it
/// would start the agent against whatever provider its defaults pick.
pub fn secret_env_from_root(
    root: &Value,
    harness: &ResolvedHarness,
) -> Result<Vec<(String, String)>, String> {
    let stored = root
        .get(SECRET_ENV_SUBTREE)
        .and_then(|subtree| subtree.get(&harness.id));
    harness
        .secret_env
        .iter()
        .map(|key| {
            stored
                .and_then(|values| values.get(key))
                .and_then(Value::as_str)
                .filter(|value| !value.is_empty())
                .map(|value| (key.clone(), value.to_string()))
                .ok_or_else(|| {
                    format!(
                        "the secret {key} for harness \"{}\" is not set; add it in Settings",
                        harness.name
                    )
                })
        })
        .collect()
}

/// The secret variables `before` declared that `after` no longer does, as
/// (harness id, variable) pairs. Their stored values are cleared on save, so a
/// later harness that reuses the id doesn't inherit a key meant for another.
pub fn dropped_secrets(before: &[AgentHarness], after: &[AgentHarness]) -> Vec<(String, String)> {
    before
        .iter()
        .flat_map(|old| {
            let kept = after.iter().find(|new| new.id == old.id);
            old.secret_env
                .iter()
                .filter(move |key| !kept.is_some_and(|new| new.secret_env.contains(key)))
                .map(move |key| (old.id.clone(), key.clone()))
        })
        .collect()
}

/// Removes `dropped` from the secret-store subtree; returns whether anything
/// was there to remove. A harness left with no values loses its entry.
pub fn prune_secrets(subtree: &mut Value, dropped: &[(String, String)]) -> bool {
    let Some(harnesses) = subtree.as_object_mut() else {
        return false;
    };
    let mut changed = false;
    for (id, key) in dropped {
        if let Some(values) = harnesses.get_mut(id).and_then(Value::as_object_mut) {
            changed |= values.remove(key).is_some();
            if values.is_empty() {
                harnesses.remove(id);
            }
        }
    }
    changed
}

/// Places a quoted instruction in a launch line: through the harness's prompt
/// arguments when it has them, otherwise as a trailing positional argument.
/// `quoted` must already be shell-quoted; the arguments around it are the
/// user's own configuration.
pub fn with_instruction(command: &str, prompt_args: Option<&str>, quoted: &str) -> String {
    match prompt_args {
        Some(args) => format!("{command} {}", args.replacen(PROMPT_PLACEHOLDER, quoted, 1)),
        None => format!("{command} {quoted}"),
    }
}

/// A harness as the workspace picker lists it (`get_agent_config`): no
/// environment, plain or secret.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessSummary {
    pub id: String,
    pub name: String,
    pub kind: HarnessKind,
    pub command: String,
}

impl From<&ResolvedHarness> for HarnessSummary {
    fn from(harness: &ResolvedHarness) -> Self {
        Self {
            id: harness.id.clone(),
            name: harness.name.clone(),
            kind: harness.kind,
            command: harness.command.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stored(id: &str, kind: HarnessKind, command: &str) -> AgentHarness {
        AgentHarness {
            id: id.to_string(),
            name: id.to_uppercase(),
            kind,
            command: command.to_string(),
            ..AgentHarness::default()
        }
    }

    fn claude() -> ResolvedHarness {
        builtin("Claude".into(), "claude --permission-mode auto".into())
    }

    #[test]
    fn the_builtin_harness_is_claude_code_only_when_its_command_runs_claude() {
        assert_eq!(claude().kind, HarnessKind::ClaudeCode);
        assert_eq!(
            builtin("Codex".into(), "codex --yolo".into()).kind,
            HarnessKind::Custom
        );
        assert_eq!(
            builtin("C".into(), "FOO=1 /opt/bin/claude".into()).kind,
            HarnessKind::ClaudeCode
        );
    }

    #[test]
    fn runs_claude_code_matches_only_the_claude_program() {
        assert!(runs_claude_code("claude --permission-mode auto"));
        assert!(runs_claude_code("/opt/homebrew/bin/claude"));
        assert!(runs_claude_code("CLAUDE_CONFIG_DIR=/tmp/c claude"));
        assert!(!runs_claude_code("codex"));
        assert!(!runs_claude_code("aider --model sonnet"));
        assert!(!runs_claude_code("npx claude-code"));
        assert!(!runs_claude_code("echo claude"));
        assert!(!runs_claude_code(""));
    }

    #[test]
    fn resolve_uses_the_default_when_no_harness_is_asked_for() {
        let harnesses = [stored("pi", HarnessKind::Pi, "pi")];
        let picked = resolve(claude(), &harnesses, Some("pi"), None).unwrap();
        assert_eq!(picked.id, "pi");
    }

    #[test]
    fn resolve_falls_back_to_the_builtin_when_the_default_was_removed() {
        let picked = resolve(claude(), &[], Some("pi"), None).unwrap();
        assert_eq!(picked.id, BUILTIN_HARNESS_ID);
    }

    #[test]
    fn resolve_refuses_an_unknown_harness_rather_than_launching_another() {
        let err = resolve(claude(), &[], None, Some("opencode")).unwrap_err();
        assert!(err.contains("opencode"));
    }

    #[test]
    fn resolve_skips_a_hand_edited_entry_with_no_command() {
        let harnesses = [stored("pi", HarnessKind::Pi, "  ")];
        assert!(resolve(claude(), &harnesses, None, Some("pi")).is_err());
    }

    #[test]
    fn resolve_strips_control_characters_from_a_hand_edited_command() {
        let harnesses = [stored("pi", HarnessKind::Pi, "pi\u{3}rm -rf /")];
        let picked = resolve(claude(), &harnesses, None, Some("pi")).unwrap();
        assert_eq!(picked.command, "pirm -rf /");
    }

    #[test]
    fn resolve_drops_reserved_variables_from_a_hand_edited_entry() {
        let mut harness = stored("pi", HarnessKind::Pi, "pi");
        harness
            .env
            .insert("YARVIS_SESSION_KEY".into(), "ws-claude:other".into());
        harness.env.insert("PI_MODEL".into(), "x".into());
        let picked = resolve(claude(), &[harness], None, Some("pi")).unwrap();
        assert_eq!(picked.env, vec![("PI_MODEL".to_string(), "x".to_string())]);
    }

    #[test]
    fn opencode_takes_its_instruction_through_prompt_by_default() {
        let harnesses = [stored("oc", HarnessKind::Opencode, "opencode")];
        let picked = resolve(claude(), &harnesses, None, Some("oc")).unwrap();
        assert_eq!(
            with_instruction(&picked.command, picked.prompt_args.as_deref(), "'do it'"),
            "opencode --prompt 'do it'"
        );
    }

    #[test]
    fn custom_prompt_args_place_the_instruction() {
        let mut harness = stored("box", HarnessKind::Custom, "cloudbox run");
        harness.prompt_args = Some("--task {prompt} --interactive".into());
        let picked = resolve(claude(), &[harness], None, Some("box")).unwrap();
        assert_eq!(
            with_instruction(&picked.command, picked.prompt_args.as_deref(), "'x'"),
            "cloudbox run --task 'x' --interactive"
        );
    }

    #[test]
    fn the_instruction_is_positional_without_prompt_args() {
        assert_eq!(with_instruction("pi", None, "'x'"), "pi 'x'");
    }

    #[test]
    fn validate_rejects_the_builtin_id_and_duplicates() {
        let dup = [
            stored("pi", HarnessKind::Pi, "pi"),
            stored("pi", HarnessKind::Pi, "pi"),
        ];
        assert!(validate(&dup, None).unwrap_err().contains("share"));
        let builtin = [stored("claude", HarnessKind::ClaudeCode, "claude")];
        assert!(validate(&builtin, None).unwrap_err().contains("built-in"));
    }

    #[test]
    fn validate_rejects_control_characters_in_what_is_typed() {
        let harness = stored("pi", HarnessKind::Pi, "pi\nrm -rf /");
        assert!(validate(&[harness], None)
            .unwrap_err()
            .contains("control characters"));
    }

    #[test]
    fn validate_requires_one_placeholder_in_prompt_args() {
        let mut harness = stored("pi", HarnessKind::Pi, "pi");
        harness.prompt_args = Some("--prompt".into());
        assert!(validate(&[harness.clone()], None).is_err());
        harness.prompt_args = Some("{prompt} {prompt}".into());
        assert!(validate(&[harness.clone()], None).is_err());
        harness.prompt_args = Some("-p {prompt}".into());
        assert!(validate(&[harness.clone()], None).is_ok());
        harness.prompt_args = Some("--task={prompt}".into());
        assert!(validate(&[harness], None).is_ok());
    }

    #[test]
    fn a_quoted_placeholder_is_refused_on_save_and_ignored_on_read() {
        for args in [
            "--prompt '{prompt}'",
            "--prompt \"{prompt}\"",
            "$X {prompt}",
            "`x` {prompt}",
        ] {
            let mut harness = stored("pi", HarnessKind::Pi, "pi");
            harness.prompt_args = Some(args.into());
            assert!(
                validate(&[harness.clone()], None).is_err(),
                "{args} was accepted"
            );
            let picked = resolve(claude(), &[harness], None, Some("pi")).unwrap();
            assert_eq!(picked.prompt_args, None, "{args} was used");
        }
    }

    #[test]
    fn validate_rejects_reserved_and_malformed_variable_names() {
        for key in [
            "YARVIS_SESSION_TOKEN",
            "yarvis_mcp_token",
            "TERM",
            "1X",
            "A-B",
            "",
        ] {
            let mut harness = stored("pi", HarnessKind::Pi, "pi");
            harness.env.insert(key.to_string(), "v".into());
            assert!(validate(&[harness], None).is_err(), "{key} was accepted");
        }
    }

    #[test]
    fn validate_rejects_a_variable_that_is_both_plain_and_secret() {
        let mut harness = stored("c2", HarnessKind::ClaudeCode, "claude");
        harness.env.insert("ANTHROPIC_API_KEY".into(), "x".into());
        harness.secret_env.push("ANTHROPIC_API_KEY".into());
        assert!(validate(&[harness], None).is_err());
    }

    #[test]
    fn validate_rejects_a_default_that_is_not_configured() {
        assert!(validate(&[], Some("pi")).is_err());
        assert!(validate(&[], Some(BUILTIN_HARNESS_ID)).is_ok());
    }

    #[test]
    fn a_bad_entry_is_dropped_without_failing_the_rest() {
        #[derive(Deserialize)]
        struct Doc {
            #[serde(default, deserialize_with = "deserialize_lenient")]
            harnesses: Option<Vec<AgentHarness>>,
        }
        let doc: Doc = serde_json::from_str(
            r#"{"harnesses": [{"id": "pi", "kind": "pi", "command": "pi"}, {"id": 3}, "x",
                 {"id": "z", "kind": "something-new", "command": "z"}]}"#,
        )
        .unwrap();
        let harnesses = doc.harnesses.unwrap();
        assert_eq!(harnesses.len(), 2);
        assert_eq!(harnesses[0].kind, HarnessKind::Pi);
        assert_eq!(harnesses[1].kind, HarnessKind::Custom);
    }

    #[test]
    fn validate_rejects_a_secret_variable_listed_twice() {
        let mut harness = stored("c2", HarnessKind::ClaudeCode, "claude");
        harness.secret_env = vec!["KEY".into(), "KEY".into()];
        assert!(validate(&[harness], None).unwrap_err().contains("twice"));
    }

    #[test]
    fn dropped_secrets_covers_removed_harnesses_and_removed_variables() {
        let mut a = stored("a", HarnessKind::Pi, "pi");
        a.secret_env = vec!["K1".into(), "K2".into()];
        let mut b = stored("b", HarnessKind::Pi, "pi");
        b.secret_env = vec!["K".into()];
        let mut a_after = a.clone();
        a_after.secret_env = vec!["K1".into()];
        assert_eq!(
            dropped_secrets(&[a, b], &[a_after]),
            vec![
                ("a".to_string(), "K2".to_string()),
                ("b".to_string(), "K".to_string())
            ]
        );
    }

    #[test]
    fn prune_secrets_removes_only_what_was_dropped() {
        let mut subtree = serde_json::json!({
            "a": { "K1": "x", "K2": "y" },
            "b": { "K": "z" }
        });
        let dropped = vec![
            ("a".to_string(), "K2".to_string()),
            ("b".to_string(), "K".to_string()),
        ];
        assert!(prune_secrets(&mut subtree, &dropped));
        assert_eq!(subtree, serde_json::json!({ "a": { "K1": "x" } }));
        assert!(!prune_secrets(&mut subtree, &dropped));
    }

    #[test]
    fn secret_env_is_read_for_the_harness_and_a_missing_value_is_an_error() {
        let mut harness = claude();
        harness.id = "c2".into();
        harness.secret_env = vec!["ANTHROPIC_API_KEY".into()];
        let root = serde_json::json!({
            SECRET_ENV_SUBTREE: { "c2": { "ANTHROPIC_API_KEY": "sk-x" } }
        });
        assert_eq!(
            secret_env_from_root(&root, &harness).unwrap(),
            vec![("ANTHROPIC_API_KEY".to_string(), "sk-x".to_string())]
        );
        assert!(secret_env_from_root(&serde_json::json!({}), &harness).is_err());
    }
}
