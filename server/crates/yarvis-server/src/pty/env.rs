//! The environment a PTY gets beyond the server's own: the sidecar tokens
//! that let a session reach back into the sidecar, and which ssh-agent its git
//! signs with.

use std::ffi::OsString;
use std::path::Path;

use hmac::{Hmac, Mac};
use sha2::Sha256;

use crate::config::SshAgentConfig;

/// What a session needs from the running sidecar to reach back into it. Set by
/// whatever starts the sidecar ([`super::PtyManager::set_sidecar_env`]);
/// until then sessions get none of the sidecar variables.
#[derive(Clone)]
pub struct SidecarSessionEnv {
    pub port: u16,
    /// The token for `/ingest/*`, the same in every session.
    pub attention_token: String,
    /// The sidecar's full-access bearer. It only signs session and harness
    /// tokens here and never reaches a session itself.
    pub signing_key: String,
    pub mcp_token: Option<String>,
}

/// The `SSH_AUTH_SOCK` a PTY gets, or `None` to leave it unset.
///
/// With the server's own agent off, git keeps signing with the user's agent:
/// `upstream_socket` when the config names one (a server under launchd has no
/// login-shell value to pass on), otherwise the server's own `inherited`
/// value. With it on, sessions get only the server agent's socket. The path
/// is set even while the vault is locked, so signing fails until unlock;
/// falling back to another agent would sign without the approval the server's
/// agent asks for.
pub(crate) fn ssh_auth_sock(
    config: &SshAgentConfig,
    server_agent: Option<&Path>,
    inherited: Option<OsString>,
) -> Option<OsString> {
    if config.enabled {
        return server_agent.map(|path| path.as_os_str().to_owned());
    }
    config
        .upstream_socket
        .as_ref()
        .map(|path| path.as_os_str().to_owned())
        .or(inherited)
}

/// The workspace a PTY id belongs to, when its id encodes one: the pinned Claude
/// session (`ws-claude:<workspaceId>`) and the workspace's own terminal panes
/// (`ws:<workspaceId>/<tab>/<pane>`). Other surfaces (the standalone Terminal
/// tab, Omni, a repo run script) belong to no workspace.
pub(crate) fn attention_workspace_id(id: &str) -> Option<&str> {
    if let Some(rest) = id.strip_prefix("ws-claude:") {
        return (!rest.is_empty()).then_some(rest);
    }
    let rest = id.strip_prefix("ws:")?;
    let workspace_id = rest.split_once('/').map_or(rest, |(head, _)| head);
    (!workspace_id.is_empty()).then_some(workspace_id)
}

/// Whether an item raised by this session could be shown to the user. Only the
/// workspaces view and the standalone Terminal tab can bring a session into
/// view, so a session hosted anywhere else (an Omni layout, a repo run script)
/// would produce an item that navigates nowhere. Kept in step with
/// `attentionSurfaceOf` in `src/components/shell/terminalTabs/sessionIds.ts`.
pub(crate) fn is_attention_addressable(id: &str) -> bool {
    // A workspace's pinned Claude session, or a pane in one of the two surfaces
    // that render tabs. Pane ids are "<surface>/<tab>/<pane>", so a surface key
    // on its own is not addressable.
    if id
        .strip_prefix("ws-claude:")
        .is_some_and(|id| !id.is_empty())
    {
        return true;
    }
    let mut parts = id.split('/');
    let Some(surface) = parts.next() else {
        return false;
    };
    if parts.count() != 2 {
        return false;
    }
    surface == "tab:terminal" || surface.strip_prefix("ws:").is_some_and(|id| !id.is_empty())
}

/// Environment a PTY needs to reach back into the sidecar.
///
/// The attention token lets a tool running in the session (a Claude Code session
/// and its hooks, a script) raise an attention item for *that* session. The
/// session key is the PTY id, which the UI maps back to the exact terminal
/// tab and pane, so an item can point at the tab that raised it rather than at
/// the workspace as a whole; `YARVIS_WORKSPACE_ID` is set only when the id
/// encodes one.
///
/// The session token proves which PTY a request came from. The attention token
/// is the same in every session, so on its own it can't stop one session from
/// speaking for another; the agent-session registry needs that, because a
/// registered pid decides who `send_session_instruction` will type at. It is
/// signed with `signing_key`, the sidecar's full-access bearer, which no session
/// holds, so no session can mint another's. See `session_token`.
///
/// The MCP token lets a Claude Code session reach the Yarvis memory tools via
/// the `.mcp.json` written at the workspace root, which references it rather
/// than carrying it. It is absent when the core has no token to give, so the
/// attention side keeps working on its own.
///
/// Both tokens go only to sessions the UI can navigate to. For attention that is
/// the whole point — an item raised elsewhere would lead nowhere. For MCP it is
/// a narrower grant than the feature needs: those are the sessions the user
/// drives interactively, which is where a Claude Code run belongs, and it keeps
/// memory access out of repo run scripts. Pure so the derivation is
/// unit-testable without a live PTY.
pub(crate) fn session_env(
    id: &str,
    port: u16,
    attention_token: &str,
    signing_key: &str,
    mcp_token: Option<&str>,
) -> Vec<(String, String)> {
    if !is_attention_addressable(id) {
        return Vec::new();
    }
    let mut env = vec![
        ("YARVIS_SIDECAR_PORT".to_string(), port.to_string()),
        (
            "YARVIS_ATTENTION_TOKEN".to_string(),
            attention_token.to_string(),
        ),
        ("YARVIS_SESSION_KEY".to_string(), id.to_string()),
        (
            "YARVIS_SESSION_TOKEN".to_string(),
            session_token(signing_key, id),
        ),
    ];
    if let Some(token) = mcp_token {
        env.push(("YARVIS_MCP_TOKEN".to_string(), token.to_string()));
    }
    if let Some(workspace_id) = attention_workspace_id(id) {
        env.push(("YARVIS_WORKSPACE_ID".to_string(), workspace_id.to_string()));
    }
    env
}

/// A PTY's session token: an HMAC of its session key under the sidecar's
/// bearer. The sidecar holds the bearer too, so it recomputes this from the
/// session key a request names instead of keeping a list of issued tokens. The
/// `session:` prefix keeps these from being valid for any other use of that key.
pub(crate) fn session_token(signing_key: &str, session_key: &str) -> String {
    hmac_sha256_hex(signing_key, &format!("session:{session_key}"))
}

/// Proves which harness the core launched in PTY `session_key`. Signed like
/// `session_token`, under a prefix of its own so neither token can stand in
/// for the other.
pub(crate) fn harness_token(signing_key: &str, session_key: &str, harness_id: &str) -> String {
    hmac_sha256_hex(signing_key, &format!("harness:{session_key}:{harness_id}"))
}

pub(crate) fn hmac_sha256_hex(key: &str, message: &str) -> String {
    let mut mac =
        Hmac::<Sha256>::new_from_slice(key.as_bytes()).expect("HMAC accepts a key of any length");
    mac.update(message.as_bytes());
    mac.finalize()
        .into_bytes()
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::review::review_session_id;
    use std::path::PathBuf;

    fn agent(enabled: bool, upstream: Option<&str>) -> SshAgentConfig {
        SshAgentConfig {
            enabled,
            upstream_socket: upstream.map(PathBuf::from),
        }
    }

    #[test]
    fn with_the_agent_off_sessions_get_the_upstream_socket_or_the_servers_own() {
        let inherited = Some(OsString::from("/tmp/launchd/Listeners"));
        assert_eq!(
            ssh_auth_sock(
                &agent(false, Some("/op/agent.sock")),
                None,
                inherited.clone()
            ),
            Some(OsString::from("/op/agent.sock"))
        );
        assert_eq!(
            ssh_auth_sock(&agent(false, None), None, inherited.clone()),
            inherited
        );
        assert_eq!(ssh_auth_sock(&agent(false, None), None, None), None);
    }

    #[test]
    fn with_the_agent_on_sessions_get_only_the_servers_agent() {
        let inherited = Some(OsString::from("/op/agent.sock"));
        assert_eq!(
            ssh_auth_sock(
                &agent(true, None),
                Some(Path::new("/data/ssh-agent.sock")),
                inherited.clone()
            ),
            Some(OsString::from("/data/ssh-agent.sock"))
        );
        // No socket known: no agent at all, rather than one that signs without asking.
        assert_eq!(ssh_auth_sock(&agent(true, None), None, inherited), None);
    }

    #[test]
    fn a_review_session_gets_no_sidecar_tokens() {
        assert!(!is_attention_addressable(&review_session_id(
            "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70"
        )));
    }

    #[test]
    fn session_env_populates_workspace_claude_sessions() {
        let env = session_env("ws-claude:abc-123", 8765, "tok", "bearer", Some("mcp-tok"));
        assert_eq!(
            env,
            vec![
                ("YARVIS_SIDECAR_PORT".to_string(), "8765".to_string()),
                ("YARVIS_ATTENTION_TOKEN".to_string(), "tok".to_string()),
                (
                    "YARVIS_SESSION_KEY".to_string(),
                    "ws-claude:abc-123".to_string()
                ),
                (
                    "YARVIS_SESSION_TOKEN".to_string(),
                    session_token("bearer", "ws-claude:abc-123")
                ),
                ("YARVIS_MCP_TOKEN".to_string(), "mcp-tok".to_string()),
                ("YARVIS_WORKSPACE_ID".to_string(), "abc-123".to_string()),
            ]
        );
    }

    #[test]
    fn session_env_keys_a_workspace_terminal_pane_by_its_pty_id() {
        let env = session_env("ws:abc-123/t1/p1", 8765, "tok", "bearer", Some("mcp-tok"));
        assert_eq!(
            env,
            vec![
                ("YARVIS_SIDECAR_PORT".to_string(), "8765".to_string()),
                ("YARVIS_ATTENTION_TOKEN".to_string(), "tok".to_string()),
                (
                    "YARVIS_SESSION_KEY".to_string(),
                    "ws:abc-123/t1/p1".to_string()
                ),
                (
                    "YARVIS_SESSION_TOKEN".to_string(),
                    session_token("bearer", "ws:abc-123/t1/p1")
                ),
                ("YARVIS_MCP_TOKEN".to_string(), "mcp-tok".to_string()),
                ("YARVIS_WORKSPACE_ID".to_string(), "abc-123".to_string()),
            ]
        );
    }

    #[test]
    fn session_env_is_empty_for_sessions_the_ui_cannot_navigate_to() {
        // An Omni-hosted terminal or a repo run script has nowhere to be shown,
        // so it must receive neither the ingest token nor the MCP token.
        assert!(session_env("omni:s1/t1/p1", 8765, "tok", "bearer", Some("mcp-tok")).is_empty());
        assert!(session_env("ws-run:repo-1", 8765, "tok", "bearer", Some("mcp-tok")).is_empty());
        // A surface key with no tab/pane names no session the UI can focus.
        assert!(session_env("ws:w1", 8765, "tok", "bearer", Some("mcp-tok")).is_empty());
        assert!(session_env("tab:terminal", 8765, "tok", "bearer", Some("mcp-tok")).is_empty());
    }

    #[test]
    fn session_env_omits_the_workspace_for_a_standalone_terminal() {
        let env = session_env(
            "tab:terminal/abc/def",
            8765,
            "tok",
            "bearer",
            Some("mcp-tok"),
        );
        assert_eq!(
            env,
            vec![
                ("YARVIS_SIDECAR_PORT".to_string(), "8765".to_string()),
                ("YARVIS_ATTENTION_TOKEN".to_string(), "tok".to_string()),
                (
                    "YARVIS_SESSION_KEY".to_string(),
                    "tab:terminal/abc/def".to_string()
                ),
                (
                    "YARVIS_SESSION_TOKEN".to_string(),
                    session_token("bearer", "tab:terminal/abc/def")
                ),
                ("YARVIS_MCP_TOKEN".to_string(), "mcp-tok".to_string()),
            ]
        );
    }

    #[test]
    fn session_env_still_carries_attention_when_no_mcp_token_exists() {
        // The two tokens are managed together today, but a session that can raise
        // an attention item must not lose that because the MCP side is absent.
        let env = session_env("tab:terminal/abc/def", 8765, "tok", "bearer", None);
        assert!(env.iter().any(|(key, _)| key == "YARVIS_ATTENTION_TOKEN"));
        assert!(!env.iter().any(|(key, _)| key == "YARVIS_MCP_TOKEN"));
    }

    #[test]
    fn hmac_sha256_hex_matches_the_standard() {
        // RFC 4231 test case 2. The sidecar verifies with node:crypto's
        // HMAC-SHA256, so both ends have to agree with the standard.
        assert_eq!(
            hmac_sha256_hex("Jefe", "what do ya want for nothing?"),
            "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843"
        );
    }

    #[test]
    fn session_token_signs_the_prefixed_session_key() {
        assert_eq!(
            session_token("bearer", "ws-claude:a"),
            hmac_sha256_hex("bearer", "session:ws-claude:a")
        );
    }

    #[test]
    fn harness_token_matches_the_sidecars_known_answer() {
        // The same value is pinned in the sidecar's agentSessionIngest tests,
        // so a change to the signed string on either side fails both.
        assert_eq!(
            harness_token("bearer", "ws-claude:a", "pi"),
            "910404caedb054b27aa5de4f10d54a8297b04f4b9806a05304fbeaf442ed8abd"
        );
    }

    #[test]
    fn harness_token_is_bound_to_the_session_and_the_harness() {
        assert_eq!(
            harness_token("bearer", "ws-claude:a", "pi"),
            hmac_sha256_hex("bearer", "harness:ws-claude:a:pi")
        );
        assert_ne!(
            harness_token("bearer", "ws-claude:a", "pi"),
            harness_token("bearer", "ws-claude:a", "claude")
        );
        assert_ne!(
            harness_token("bearer", "ws-claude:a", "pi"),
            harness_token("bearer", "ws-claude:b", "pi")
        );
    }

    #[test]
    fn session_token_differs_per_session() {
        assert_ne!(
            session_token("bearer", "ws-claude:a"),
            session_token("bearer", "ws-claude:b")
        );
    }

    #[test]
    fn attention_workspace_id_reads_both_workspace_session_shapes() {
        assert_eq!(attention_workspace_id("ws-claude:w1"), Some("w1"));
        assert_eq!(attention_workspace_id("ws:w1/t1/p1"), Some("w1"));
        assert_eq!(attention_workspace_id("ws:w1"), Some("w1"));
        assert_eq!(attention_workspace_id("ws-run:repo-1"), None);
        assert_eq!(attention_workspace_id("omni:r1/t1/p1"), None);
        assert_eq!(attention_workspace_id("ws:"), None);
        assert_eq!(attention_workspace_id("ws-claude:"), None);
    }
}
