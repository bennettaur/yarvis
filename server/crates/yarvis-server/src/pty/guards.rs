//! Text Yarvis types into a PTY on someone else's behalf: session names,
//! instructions and slash commands sent to a running agent, and the launch
//! lines that start one. Every caller-supplied value that reaches a shell or an
//! agent's prompt passes through here first.

use crate::agent_policy::{
    is_refused_slash_command, is_valid_slash_command_name, normalize_slash_command_name,
};
use crate::harness::HarnessKind;

/// Longest session name accepted into a launch line. Names come from issue
/// titles, so this bounds what a single line can carry rather than reflecting
/// anything the shell enforces.
pub(crate) const MAX_SESSION_NAME_CHARS: usize = 200;

/// Characters a session name may not carry into a launch line.
///
/// `is_control` (Unicode Cc) is the part that matters for injection: the launch
/// line is not handed to a shell parser — it is typed into an interactive shell
/// (see `spawn_session`), whose line editor treats bytes like 0x03 (interrupt)
/// and 0x15 (kill-line) as editing commands. Those act before quoting is ever
/// parsed, so they discard the opening quote and let whatever follows run as a
/// new command line.
///
/// The rest are not an injection risk — they are multi-byte UTF-8, so a shell
/// sees them as ordinary text — but the same name is the session title shown in
/// claude.ai/code and the Claude mobile app, where a bidi override renders a
/// title that reads as something other than what it is. Both come from
/// third-party text (a GitHub or JIRA issue title reaches here via
/// `create_workspace`), so both are stripped.
pub(crate) fn is_unsafe_name_char(c: char) -> bool {
    c.is_control()
        || matches!(c,
            '\u{2028}' | '\u{2029}'                 // line / paragraph separators
            | '\u{200e}' | '\u{200f}'               // LTR / RTL marks
            | '\u{202a}'..='\u{202e}'               // embedding / override
            | '\u{2066}'..='\u{2069}'               // isolates
        )
}

/// Strips unsafe characters from a session name and bounds its length. See
/// `is_unsafe_name_char` for why quoting alone is not sufficient here.
pub(crate) fn sanitize_session_name(name: &str) -> String {
    name.chars()
        .filter(|c| !is_unsafe_name_char(*c))
        .take(MAX_SESSION_NAME_CHARS)
        .collect::<String>()
        .trim()
        .to_string()
}

/// Longest instruction accepted into a running agent session. Instructions are
/// composed by the chat model from text it was given, so this bounds what one
/// call can type rather than reflecting a limit the agent enforces.
pub(crate) const MAX_INSTRUCTION_CHARS: usize = 4000;

/// Prefixes an agent's prompt reads as something other than a request. Claude
/// Code takes `!` into bash mode (the line runs as a shell command), `/` as a
/// slash command, `#` as a write to project memory, and `@` opens file
/// completion. None of those are gated by `--permission-mode auto`, because none
/// of them is a tool call — so the foreground check below, which only decides
/// *who* reads the line, cannot stop them.
///
/// The set is a property of the session's harness, which the user can swap
/// for another agent, so an instruction is rejected rather than stripped:
/// deleting a leading character silently changes what was asked for, and no
/// legitimate instruction needs to open with punctuation.
pub(crate) const INSTRUCTION_PREFIXES_REJECTED: [char; 4] = ['!', '/', '#', '@'];

/// Turns the control characters that would submit early into spaces and
/// collapses the runs they leave. See `prepare_instruction` for why.
pub(crate) fn sanitize_prompt_text(text: &str) -> String {
    let spaced: String = text
        .chars()
        .map(|c| if is_unsafe_name_char(c) { ' ' } else { c })
        .collect();
    // Collapsing runs keeps a stripped newline from leaving a double space, and
    // is what makes the substitution above read as the original text.
    spaced.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Prepares an instruction for typing at a live agent prompt, or explains why it
/// can't be sent.
///
/// Unsafe characters become spaces rather than being deleted. The character
/// rules are `sanitize_session_name`'s, for the same reasons, and they matter
/// more here: `is_control` covers CR and LF, which the agent's line editor reads
/// as "submit", so leaving them in would let one instruction submit several.
/// Deleting them instead would weld the surrounding words together and submit
/// *that*, which is how a two-line instruction turns into nonsense the agent
/// still acts on.
///
/// Over-length is an error, not a truncation: `pty_write` already refuses an
/// oversized payload rather than trimming it, and a sentence cut in half here
/// would be submitted and acted on. The caller bounds the same length, so
/// reaching this is a mismatch between the two limits — exactly what should be
/// heard about rather than papered over.
pub(crate) fn prepare_instruction(text: &str) -> Result<String, String> {
    if text.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(format!(
            "instruction exceeds {MAX_INSTRUCTION_CHARS} characters"
        ));
    }
    let collapsed = sanitize_prompt_text(text);
    if collapsed.is_empty() {
        return Err("instruction is empty".into());
    }
    if let Some(first) = collapsed.chars().next()
        && INSTRUCTION_PREFIXES_REJECTED.contains(&first)
    {
        return Err(format!(
            "instruction may not start with '{first}'; the agent reads that as a command rather than a request"
        ));
    }
    Ok(collapsed)
}

/// The line to type for slash command `name` with optional `arguments`, or why
/// it can't be sent. The leading `/` is optional on input. The name must be on
/// `allowed` and carry nothing else; the arguments are cleaned the way
/// `prepare_instruction` cleans an instruction, so they can't submit early.
/// They need no prefix check, since the line already opens with the command.
/// Names compare case-insensitively, since Claude Code matches them that way.
pub(crate) fn prepare_slash_command(
    name: &str,
    arguments: Option<&str>,
    allowed: &[String],
) -> Result<String, String> {
    let name = normalize_slash_command_name(name);
    if !is_valid_slash_command_name(&name) {
        return Err("not a slash command name; send the command alone, with no arguments".into());
    }
    if is_refused_slash_command(&name) {
        return Err(format!(
            "/{name} changes what the session may do, so Yarvis never sends it"
        ));
    }
    if !allowed.iter().any(|a| a.eq_ignore_ascii_case(&name)) {
        return Err(format!(
            "/{name} is not an allowed slash command; the user can add it in Settings → Repositories → Agent"
        ));
    }
    let arguments = sanitize_prompt_text(arguments.unwrap_or_default());
    let line = if arguments.is_empty() {
        format!("/{name}")
    } else {
        format!("/{name} {arguments}")
    };
    if line.chars().count() > MAX_INSTRUCTION_CHARS {
        return Err(format!(
            "slash command exceeds {MAX_INSTRUCTION_CHARS} characters"
        ));
    }
    Ok(line)
}

/// Composes the remote-control launch line from a base command and a session
/// name. Extracted from `spawn_claude_session` so the composition is unit-testable
/// without reading the environment or spawning a PTY.
pub(crate) fn remote_control_command(base: &str, name: &str) -> String {
    // `--remote-control` takes the name as an optional value, so Claude Code
    // reads a name starting with `-` as a flag of its own. Names come from issue
    // titles, so one titled `--dangerously-skip-permissions` would otherwise
    // start the session with that flag. Dashes are stripped after sanitizing,
    // so a removed bidi or control character can't leave one in front, and
    // whitespace with them, so `- -x` can't leave one either.
    let sanitized = sanitize_session_name(name);
    let name = sanitized.trim_start_matches(|c: char| c == '-' || c.is_whitespace());
    format!(
        "{} --remote-control {}",
        base.trim(),
        shell_single_quote(name)
    )
}

/// True when `id` is shaped like a Claude Code session id, a UUID. It is typed
/// into a shell, and Claude would read one starting with `-` as a flag, so
/// nothing else is accepted, on top of being quoted.
pub(crate) fn is_valid_resume_id(id: &str) -> bool {
    let groups: Vec<&str> = id.split('-').collect();
    groups.len() == 5
        && groups
            .iter()
            .zip([8, 4, 4, 4, 12])
            .all(|(g, len)| g.len() == len && g.chars().all(|c| c.is_ascii_hexdigit()))
}

/// Refuses a `resume` the launch can't honour: an id that isn't a Claude Code
/// session id, or a harness that isn't Claude Code. Refused rather than
/// launched without the flag, since an unattended relaunch should continue the
/// session that was cut off, not start a different agent.
pub(crate) fn check_resume(kind: HarnessKind, resume: Option<&str>) -> Result<(), String> {
    match resume {
        None => Ok(()),
        Some(id) if !is_valid_resume_id(id) => Err("invalid resume session id".into()),
        Some(_) if kind != HarnessKind::ClaudeCode => {
            Err("the agent harness is not Claude Code, so it can't resume a session".into())
        }
        Some(_) => Ok(()),
    }
}

/// Refuses Remote Control for a harness that isn't Claude Code. Appending the
/// flag anyway would either fail the launch or start a session the caller
/// then tells the user they can drive from their phone.
pub(crate) fn check_remote_control(kind: HarnessKind, remote_control: bool) -> Result<(), String> {
    if remote_control && kind != HarnessKind::ClaudeCode {
        return Err("Remote Control needs a Claude Code harness".into());
    }
    Ok(())
}

/// The launch line for an agent session: the base command, with Remote Control
/// added only when asked for, `--resume` when it continues an earlier Claude
/// Code session, and an `instruction` the session should start on, quoted as a
/// single argument and placed where the harness's `prompt_args` put `{prompt}`
/// (appended at the end without them).
///
/// Extracted from `spawn_claude_session` alongside `remote_control_command` so
/// the choice is unit-testable without app state.
///
/// The instruction carries issue text, which an outside party writes, so it is
/// quoted like the session name rather than interpolated raw.
pub(crate) fn agent_launch_command(
    base: &str,
    name: &str,
    remote_control: bool,
    resume: Option<&str>,
    instruction: Option<&str>,
    prompt_args: Option<&str>,
) -> String {
    let mut command = if remote_control {
        remote_control_command(base, name)
    } else {
        base.trim().to_string()
    };
    if let Some(id) = resume {
        command = format!("{} --resume {}", command, shell_single_quote(id));
    }
    match instruction.map(str::trim).filter(|i| !i.is_empty()) {
        Some(instruction) => crate::harness::with_instruction(
            &command,
            prompt_args,
            &shell_single_quote(instruction),
        ),
        None => command,
    }
}

/// Builds the shell-safe single-quoted form of `s` for injection into a shell
/// command line. Wraps in single quotes and escapes any embedded single quote.
pub(crate) fn shell_single_quote(s: &str) -> String {
    let mut out = String::with_capacity(s.len() + 2);
    out.push('\'');
    for c in s.chars() {
        if c == '\'' {
            out.push_str("'\\''");
        } else {
            out.push(c);
        }
    }
    out.push('\'');
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::agent_policy::{
        DEFAULT_ALLOWED_SLASH_COMMANDS, MAX_SLASH_COMMAND_CHARS, REFUSED_SLASH_COMMANDS,
    };

    #[test]
    fn prepare_instruction_replaces_the_newlines_that_would_submit_early() {
        // Each newline would submit what precedes it, turning one instruction
        // into three the agent acts on in turn. They become spaces rather than
        // vanishing, so the words either side stay separate words.
        assert_eq!(
            prepare_instruction("resolve the conflicts\rthen commit\nand push"),
            Ok("resolve the conflicts then commit and push".to_string())
        );
    }

    #[test]
    fn prepare_instruction_rejects_an_over_length_instruction() {
        // Truncating would submit a sentence cut in half, which the agent acts on.
        let long = "a".repeat(MAX_INSTRUCTION_CHARS + 1);
        assert_eq!(
            prepare_instruction(&long),
            Err(format!(
                "instruction exceeds {MAX_INSTRUCTION_CHARS} characters"
            ))
        );
        assert!(prepare_instruction(&"a".repeat(MAX_INSTRUCTION_CHARS)).is_ok());
    }

    #[test]
    fn prepare_instruction_rejects_what_sanitizes_to_nothing() {
        // Otherwise this presses enter on whatever the agent already had in its
        // prompt.
        assert_eq!(
            prepare_instruction("  \u{202e}  "),
            Err("instruction is empty".to_string())
        );
    }

    #[test]
    fn prepare_instruction_rejects_the_agent_prompt_prefixes() {
        // `!` is bash mode in Claude Code, so this one would run a shell command
        // that no permission mode gates.
        for text in ["!rm -rf /", "/exit", "#remember this", "@src/main.rs"] {
            assert!(
                prepare_instruction(text).is_err(),
                "expected {text:?} to be rejected"
            );
        }
        // A leading prefix is rejected even when whitespace hides it.
        assert!(prepare_instruction("  !whoami").is_err());
        // The same characters mid-instruction are ordinary text.
        assert!(prepare_instruction("run the tests with !important skipped").is_ok());
    }

    fn allowed(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn prepare_slash_command_types_an_allowed_command() {
        let list = allowed(&["compact", "code-review-team-core:do-code-review"]);
        assert_eq!(
            prepare_slash_command("compact", None, &list),
            Ok("/compact".into())
        );
        assert_eq!(
            prepare_slash_command(" /Compact ", None, &list),
            Ok("/compact".into())
        );
        assert_eq!(
            prepare_slash_command("code-review-team-core:do-code-review", None, &list),
            Ok("/code-review-team-core:do-code-review".into())
        );
    }

    #[test]
    fn prepare_slash_command_refuses_a_command_not_on_the_list() {
        let err = prepare_slash_command("deploy", None, &allowed(&["compact"])).unwrap_err();
        assert!(err.contains("not an allowed slash command"), "{err}");
    }

    #[test]
    fn a_command_that_widens_the_session_is_refused_even_when_listed() {
        for name in REFUSED_SLASH_COMMANDS {
            assert!(!DEFAULT_ALLOWED_SLASH_COMMANDS.contains(name));
            let err = prepare_slash_command(name, None, &allowed(&[name])).unwrap_err();
            assert!(err.contains("never sends it"), "{err}");
            let namespaced = format!("someplugin:{name}");
            let err =
                prepare_slash_command(&namespaced, None, &allowed(&[&namespaced])).unwrap_err();
            assert!(err.contains("never sends it"), "{err}");
            let upper = name.to_uppercase();
            let err = prepare_slash_command(&upper, None, &allowed(&[&upper])).unwrap_err();
            assert!(err.contains("never sends it"), "{err}");
        }
    }

    #[test]
    fn prepare_slash_command_cleans_its_arguments() {
        // A newline in the arguments would submit `/compact focus` and then
        // `/login` as a second command.
        let list = allowed(&["compact"]);
        assert_eq!(
            prepare_slash_command("compact", Some("focus on\r\n/login  the tests"), &list),
            Ok("/compact focus on /login the tests".into())
        );
        assert_eq!(
            prepare_slash_command("compact", Some(" \u{202e} "), &list),
            Ok("/compact".into())
        );
        let long = "a".repeat(MAX_INSTRUCTION_CHARS);
        assert!(prepare_slash_command("compact", Some(&long), &list).is_err());
    }

    #[test]
    fn prepare_slash_command_refuses_a_name_carrying_anything_else() {
        // Arguments go in their own field, so a name with text after it is
        // refused rather than split.
        let list = allowed(&["compact"]);
        let too_long = "a".repeat(MAX_SLASH_COMMAND_CHARS + 1);
        for text in [
            "compact focus on the tests",
            "compact\r/login",
            "//compact",
            "!compact",
            ":compact",
            "plugin:",
            "a:b:c",
            "",
            too_long.as_str(),
        ] {
            assert!(
                prepare_slash_command(text, None, &list).is_err(),
                "expected {text:?} to be refused"
            );
        }
    }

    #[test]
    fn remote_control_command_appends_flag_and_quotes_name() {
        let cmd = remote_control_command("claude --permission-mode auto", "Rename the API");
        assert_eq!(
            cmd,
            "claude --permission-mode auto --remote-control 'Rename the API'"
        );
    }

    #[test]
    fn remote_control_command_strips_control_characters_from_the_name() {
        // The launch line is typed into an interactive shell, whose line editor
        // acts on 0x03 (interrupt) and 0x15 (kill-line) before any quoting is
        // parsed — so a quoted name carrying one ends the quote and runs the rest
        // as its own command. Names come from issue titles, which are attacker
        // authorable, so these must never survive into the line.
        for injected in ["\u{3}", "\u{15}", "\r", "\n", "\u{1b}"] {
            let name = format!("Fix bug{injected}id > /tmp/pwned");
            let cmd = remote_control_command("claude", &name);
            assert!(
                !cmd.chars().any(is_unsafe_name_char),
                "unsafe character survived in: {cmd:?}"
            );
            assert_eq!(cmd, "claude --remote-control 'Fix bugid > /tmp/pwned'");
        }
    }

    #[test]
    fn remote_control_command_strips_bidi_and_separator_characters() {
        // Not a shell risk — these are multi-byte UTF-8 — but the name is also the
        // session title shown in claude.ai/code, where an override renders a title
        // that reads as something other than what it is.
        for injected in ["\u{202e}", "\u{2066}", "\u{200f}", "\u{2028}"] {
            let name = format!("Fix{injected}bug");
            let cmd = remote_control_command("claude", &name);
            assert_eq!(cmd, "claude --remote-control 'Fixbug'");
        }
    }

    #[test]
    fn remote_control_command_bounds_the_name_length() {
        let cmd = remote_control_command("claude", &"a".repeat(MAX_SESSION_NAME_CHARS + 50));
        assert_eq!(
            cmd,
            format!(
                "claude --remote-control '{}'",
                "a".repeat(MAX_SESSION_NAME_CHARS)
            )
        );
    }

    #[test]
    fn agent_launch_command_adds_remote_control_only_when_asked() {
        assert_eq!(
            agent_launch_command(
                "claude --permission-mode auto",
                "Fix bug",
                true,
                None,
                None,
                None
            ),
            "claude --permission-mode auto --remote-control 'Fix bug'"
        );
        // A session started at the machine is driven in its own tab; Remote
        // Control is enabled from inside it if the user later steps away.
        assert_eq!(
            agent_launch_command(
                "claude --permission-mode auto",
                "Fix bug",
                false,
                None,
                None,
                None
            ),
            "claude --permission-mode auto"
        );
    }

    #[test]
    fn agent_launch_command_appends_an_instruction_as_one_quoted_argument() {
        assert_eq!(
            agent_launch_command(
                "claude --permission-mode auto",
                "Fix bug",
                false,
                None,
                Some("Read .yarvis/brief.md"),
                None
            ),
            "claude --permission-mode auto 'Read .yarvis/brief.md'"
        );
        // Remote Control and an instruction compose; the name and the
        // instruction are quoted independently.
        assert_eq!(
            agent_launch_command("claude", "Fix bug", true, None, Some("Do the thing"), None),
            "claude --remote-control 'Fix bug' 'Do the thing'"
        );
    }

    #[test]
    fn agent_launch_command_quotes_an_instruction_that_carries_shell_metacharacters() {
        // Issue text is written by an outside party, so it must not be able to
        // end the argument and start a command of its own.
        let cmd = agent_launch_command(
            "claude",
            "n",
            false,
            None,
            Some("it's; rm -rf ~ `id` $(id)"),
            None,
        );
        assert_eq!(cmd, r"claude 'it'\''s; rm -rf ~ `id` $(id)'");
    }

    #[test]
    fn agent_launch_command_quotes_a_hostile_instruction_placed_by_prompt_args() {
        // A harness's own placement must not weaken the quoting, and a
        // `{prompt}` inside the instruction is text, not a second placeholder.
        let cmd = agent_launch_command(
            "opencode",
            "n",
            false,
            None,
            Some("it's; rm -rf ~ $(id) {prompt}"),
            Some("run --prompt {prompt} --quiet"),
        );
        assert_eq!(
            cmd,
            r"opencode run --prompt 'it'\''s; rm -rf ~ $(id) {prompt}' --quiet"
        );
    }

    #[test]
    fn agent_launch_command_resumes_a_session_before_any_instruction() {
        assert_eq!(
            agent_launch_command(
                "claude --permission-mode auto",
                "Fix bug",
                false,
                Some("0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"),
                None,
                None
            ),
            "claude --permission-mode auto --resume '0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70'"
        );
        assert_eq!(
            agent_launch_command(
                "claude",
                "Fix bug",
                true,
                Some("0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"),
                Some("Go on"),
                None
            ),
            "claude --remote-control 'Fix bug' --resume '0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70' 'Go on'"
        );
    }

    #[test]
    fn is_valid_resume_id_accepts_only_a_uuid() {
        assert!(is_valid_resume_id("0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"));
        assert!(is_valid_resume_id("0B6A3F1E-9C1D-4E55-8A5B-2F3C4D5E6F70"));
        assert!(!is_valid_resume_id(""));
        assert!(!is_valid_resume_id("abc-123"));
        // Claude would read this as a flag rather than the option's value.
        assert!(!is_valid_resume_id("--dangerously-skip-permissions"));
        assert!(!is_valid_resume_id("-b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"));
        assert!(!is_valid_resume_id(
            "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70'; id"
        ));
    }

    #[test]
    fn check_resume_refuses_a_resume_the_agent_cannot_take() {
        let id = "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70";
        assert!(check_resume(HarnessKind::ClaudeCode, Some(id)).is_ok());
        assert!(
            check_resume(
                HarnessKind::ClaudeCode,
                Some("--dangerously-skip-permissions")
            )
            .is_err()
        );
        // Another agent would read the flag as its own, or fail on it.
        assert!(check_resume(HarnessKind::Custom, Some(id)).is_err());
        assert!(check_resume(HarnessKind::Pi, Some(id)).is_err());
        // Without a resume, any agent launches as before.
        assert!(check_resume(HarnessKind::Custom, None).is_ok());
    }

    #[test]
    fn check_remote_control_needs_a_claude_code_harness() {
        assert!(check_remote_control(HarnessKind::ClaudeCode, true).is_ok());
        assert!(check_remote_control(HarnessKind::Opencode, true).is_err());
        assert!(check_remote_control(HarnessKind::Opencode, false).is_ok());
    }

    #[test]
    fn agent_launch_command_ignores_a_blank_instruction() {
        assert_eq!(
            agent_launch_command("claude", "n", false, None, Some("   "), None),
            "claude"
        );
    }

    #[test]
    fn remote_control_command_never_passes_a_name_that_reads_as_a_flag() {
        assert_eq!(
            remote_control_command("claude", "--dangerously-skip-permissions"),
            "claude --remote-control 'dangerously-skip-permissions'"
        );
        assert_eq!(
            remote_control_command("claude", "- -  Fix bug"),
            "claude --remote-control 'Fix bug'"
        );
        // Sanitizing removes the bidi override first, so the dash is then trimmed.
        assert_eq!(
            remote_control_command("claude", "\u{202e}-p"),
            "claude --remote-control 'p'"
        );
        // A name of only dashes becomes an empty value, which can't read as a flag.
        assert_eq!(
            remote_control_command("claude", "---"),
            "claude --remote-control ''"
        );
        // Only the ASCII hyphen-minus starts a flag, so a look-alike dash is kept.
        assert_eq!(
            remote_control_command("claude", "\u{2010}p"),
            "claude --remote-control '\u{2010}p'"
        );
        // Only a leading dash reads as a flag.
        assert_eq!(
            remote_control_command("claude", "Fix the --resume flag"),
            "claude --remote-control 'Fix the --resume flag'"
        );
    }

    #[test]
    fn remote_control_command_uses_a_custom_base() {
        let cmd = remote_control_command("claude --model opus --permission-mode plan", "Fix bug");
        assert_eq!(
            cmd,
            "claude --model opus --permission-mode plan --remote-control 'Fix bug'"
        );
    }

    #[test]
    fn remote_control_command_escapes_single_quotes_in_the_name() {
        let cmd = remote_control_command("claude", "Mike's task");
        assert_eq!(cmd, "claude --remote-control 'Mike'\\''s task'");
    }
}
