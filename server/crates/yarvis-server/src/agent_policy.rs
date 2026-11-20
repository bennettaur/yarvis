//! The limits and defaults a workspace agent session runs under: the PTY cap,
//! the agent's name and launch command, and the slash commands Yarvis may type.
//!
//! These are the parts of `src-tauri/src/pty.rs` that the settings module
//! validates against and the PTY module enforces, kept apart so both read the
//! same constants. The stored values live in `settings.json`
//! ([`crate::settings`]); this module only says what they default to and which
//! of them are allowed.

/// Default cap on the number of live PTY sessions. A multi-repo workspace opens
/// a parent terminal plus a run-script session per repo, so several workspaces
/// can be live at once; this still bounds attaching with novel ids from
/// spawning shells without limit. Overridable in Settings, which persists the
/// chosen value as `maxPtySessions`.
pub const DEFAULT_MAX_SESSIONS: usize = 60;

/// Hard ceiling on the configured cap. The setting is writable from the UI and
/// persists across restarts, so a value that outlived whatever wrote it must
/// not be able to retire the guard entirely. At roughly three file descriptors
/// per session, past this point an `EMFILE` would surface somewhere unrelated
/// before the cap did.
pub const MAX_CONFIGURABLE_SESSIONS: usize = 1000;

/// Resolves the session cap from the stored setting. An unset or zero setting
/// falls back to the default, since a zero cap would make every session
/// unopenable. Anything above the ceiling is clamped rather than rejected, so a
/// hand-edited value still yields a usable cap.
pub fn resolve_max_sessions(configured: Option<usize>) -> usize {
    configured
        .filter(|n| *n > 0)
        .map(|n| n.min(MAX_CONFIGURABLE_SESSIONS))
        .unwrap_or(DEFAULT_MAX_SESSIONS)
}

/// Base command a workspace's agent session is launched from. Configurable in
/// Settings as `agentCommand`, and overridable per launch with the
/// `YARVIS_CLAUDE_COMMAND` env var. This is the built-in harness's command; see
/// [`crate::harness`] for the others.
pub const DEFAULT_AGENT_COMMAND: &str = "claude --permission-mode auto";

/// Display name for a workspace's agent, used as its tab title. Configurable in
/// Settings as `agentName`.
pub const DEFAULT_AGENT_NAME: &str = "Claude";

/// Env override for the agent command, for when a command has to be injected
/// without the settings file. It outranks the stored value.
const AGENT_COMMAND_ENV: &str = "YARVIS_CLAUDE_COMMAND";

/// The agent command override in the environment, if a non-blank one is set.
/// Read on each use so a restart-injected change is picked up.
pub fn agent_command_env() -> Option<String> {
    non_blank(std::env::var(AGENT_COMMAND_ENV).ok())
}

/// Resolves the agent command from the env override and the stored setting.
/// The env override wins, then the stored setting; a blank value at either
/// level is treated as unset rather than as an empty command.
///
/// Control characters are stripped rather than trusted. The settings setter
/// rejects them on write, but `settings.json` is hand-editable and the env
/// override never passes through it. Both end up typed into an interactive
/// shell, where 0x03 and 0x15 break out of the line.
pub fn resolve_agent_command(env: Option<String>, configured: Option<String>) -> String {
    non_blank(env)
        .or_else(|| non_blank(configured))
        .map(|s| s.chars().filter(|c| !c.is_control()).collect::<String>())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| DEFAULT_AGENT_COMMAND.to_string())
}

/// The agent's display name from the stored setting, or the default.
pub fn resolve_agent_name(configured: Option<String>) -> String {
    non_blank(configured).unwrap_or_else(|| DEFAULT_AGENT_NAME.to_string())
}

/// Slash commands any workspace session may be sent without the user listing
/// them. `/compact` only summarizes the session's own context.
pub const DEFAULT_ALLOWED_SLASH_COMMANDS: &[&str] = &["compact"];

/// Commands and skills that change what a session may do or who it acts as, or
/// send its transcript off the machine. Refused even when listed in Settings: a
/// model that read an injected "run /permissions" would otherwise only need the
/// user to add it. `settings.json` is hand-editable, so this is checked on every
/// send, not only on save. Some names are aliases or skills that may not exist
/// in a given Claude Code version; refusing a name nobody uses costs nothing.
pub const REFUSED_SLASH_COMMANDS: &[&str] = &[
    "add-dir",
    "agents",
    "allowed-tools",
    "bug",
    "config",
    "feedback",
    "fewer-permission-prompts",
    "hooks",
    "install-github-app",
    "login",
    "logout",
    "marketplace",
    "mcp",
    "permissions",
    "plugin",
    "plugins",
    "privacy-settings",
    "sandbox",
    "settings",
    "statusline",
    "terminal-setup",
    "update-config",
];

/// Whether normalized `name` is refused, either itself or as a plugin's skill
/// (`someplugin:update-config` widens a session as much as `update-config`).
pub fn is_refused_slash_command(name: &str) -> bool {
    let skill = name.rsplit(':').next().unwrap_or(name);
    REFUSED_SLASH_COMMANDS.contains(&name) || REFUSED_SLASH_COMMANDS.contains(&skill)
}

/// Longest slash-command name accepted. Plugin skills are namespaced
/// (`plugin:skill`), so this leaves room for both parts.
pub const MAX_SLASH_COMMAND_CHARS: usize = 100;

/// Whether `name` is shaped like a Claude Code command or skill name: starts
/// with a letter or digit, then letters, digits, `-`, `_` or one `:` between a
/// plugin and its skill. Anything else (spaces, a second `/`, punctuation) is
/// refused so no argument text can ride along with the name.
pub fn is_valid_slash_command_name(name: &str) -> bool {
    name.chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric())
        && name.chars().count() <= MAX_SLASH_COMMAND_CHARS
        && name.matches(':').count() <= 1
        && !name.ends_with(':')
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | ':'))
}

/// The stored and compared form of a command name: trimmed, without its
/// leading `/`, lower-case. Shared by the settings setter and the send check so
/// what is saved is what a send is checked against.
pub fn normalize_slash_command_name(name: &str) -> String {
    let name = name.trim();
    name.strip_prefix('/').unwrap_or(name).to_ascii_lowercase()
}

/// The slash commands a session may be sent: the defaults plus the user's own
/// list from Settings.
pub fn merge_allowed_slash_commands(configured: Option<Vec<String>>) -> Vec<String> {
    // A hand-edited entry like "/Do-Code-Review" still means that command.
    let configured = configured
        .unwrap_or_default()
        .into_iter()
        .map(|name| normalize_slash_command_name(&name));
    DEFAULT_ALLOWED_SLASH_COMMANDS
        .iter()
        .map(|s| s.to_string())
        .chain(configured)
        .collect()
}

/// The trimmed value, or `None` when it is absent or blank. An emptied field in
/// the UI means "use the default", stored the same way as never having set one.
pub fn non_blank(value: Option<String>) -> Option<String> {
    value
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allowed(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn resolve_agent_command_uses_the_default_when_nothing_is_set() {
        assert_eq!(resolve_agent_command(None, None), DEFAULT_AGENT_COMMAND);
    }

    #[test]
    fn resolve_agent_command_lets_the_env_override_outrank_the_setting() {
        assert_eq!(
            resolve_agent_command(
                Some("claude --model opus".to_string()),
                Some("codex --yolo".to_string())
            ),
            "claude --model opus"
        );
        assert_eq!(
            resolve_agent_command(None, Some("  codex --yolo  ".to_string())),
            "codex --yolo"
        );
    }

    #[test]
    fn resolve_agent_command_treats_a_blank_value_as_unset() {
        assert_eq!(
            resolve_agent_command(Some("  ".to_string()), Some("codex --yolo".to_string())),
            "codex --yolo"
        );
        assert_eq!(
            resolve_agent_command(None, Some("  ".to_string())),
            DEFAULT_AGENT_COMMAND
        );
    }

    #[test]
    fn resolve_agent_command_strips_control_characters_from_either_source() {
        assert_eq!(
            resolve_agent_command(None, Some("claude\u{3}rm -rf /".to_string())),
            "clauderm -rf /"
        );
        assert_eq!(
            resolve_agent_command(Some("claude\u{15}whoami".to_string()), None),
            "claudewhoami"
        );
    }

    #[test]
    fn a_blank_agent_name_is_the_default() {
        assert_eq!(resolve_agent_name(Some(" ".into())), DEFAULT_AGENT_NAME);
        assert_eq!(resolve_agent_name(Some("Codex".into())), "Codex");
    }

    #[test]
    fn resolve_max_sessions_falls_back_or_clamps() {
        assert_eq!(resolve_max_sessions(None), DEFAULT_MAX_SESSIONS);
        assert_eq!(resolve_max_sessions(Some(0)), DEFAULT_MAX_SESSIONS);
        assert_eq!(resolve_max_sessions(Some(1)), 1);
        assert_eq!(resolve_max_sessions(Some(120)), 120);
        assert_eq!(
            resolve_max_sessions(Some(usize::MAX)),
            MAX_CONFIGURABLE_SESSIONS
        );
    }

    #[test]
    fn the_defaults_and_the_user_list_are_both_allowed() {
        assert_eq!(merge_allowed_slash_commands(None), allowed(&["compact"]));
        assert_eq!(
            merge_allowed_slash_commands(Some(allowed(&[" /Do-Code-Review "]))),
            allowed(&["compact", "do-code-review"])
        );
    }

    #[test]
    fn no_refused_command_is_a_default_and_a_namespaced_one_is_refused_too() {
        for name in REFUSED_SLASH_COMMANDS {
            assert!(!DEFAULT_ALLOWED_SLASH_COMMANDS.contains(name));
            assert!(is_refused_slash_command(name));
            assert!(is_refused_slash_command(&format!("someplugin:{name}")));
        }
        assert!(!is_refused_slash_command("compact"));
    }

    #[test]
    fn a_name_carrying_anything_else_is_not_a_command_name() {
        let too_long = "a".repeat(MAX_SLASH_COMMAND_CHARS + 1);
        for text in [
            "compact focus on the tests",
            "compact\r/login",
            "/compact",
            "!compact",
            ":compact",
            "plugin:",
            "a:b:c",
            "",
            too_long.as_str(),
        ] {
            assert!(!is_valid_slash_command_name(text), "accepted {text:?}");
        }
        assert!(is_valid_slash_command_name(
            "code-review-team-core:do-code-review"
        ));
    }
}
