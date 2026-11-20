//! The sidecar's control socket over a real Unix socket: the alarm events, the
//! two secret writes, and the agent-session methods against a real `/bin/sh`.
//! The PTY tests open PTYs, which Claude Code's sandbox refuses.

#![cfg(unix)]

mod common;

use std::path::PathBuf;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::net::UnixStream;
use yarvis_server::pty::PtyOptions;
use yarvis_server::pty::session::Size;
use yarvis_server::secret_store::SecretBackend;

use common::{Server, WAIT, serve, until};

const WORKSPACE: &str = "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70";

struct Control {
    reader: BufReader<tokio::net::unix::OwnedReadHalf>,
    writer: tokio::net::unix::OwnedWriteHalf,
    next_id: u64,
}

impl Control {
    async fn connect(path: &PathBuf) -> Self {
        let (read, writer) = UnixStream::connect(path).await.unwrap().into_split();
        Self {
            reader: BufReader::new(read),
            writer,
            next_id: 0,
        }
    }

    async fn raw(&mut self, line: &str) -> Value {
        self.writer
            .write_all(format!("{line}\n").as_bytes())
            .await
            .unwrap();
        let mut reply = String::new();
        tokio::time::timeout(WAIT, self.reader.read_line(&mut reply))
            .await
            .expect("no reply in time")
            .unwrap();
        serde_json::from_str(&reply).unwrap()
    }

    async fn call(&mut self, method: &str, params: Value) -> Value {
        self.next_id += 1;
        let reply = self
            .raw(&json!({"id": self.next_id, "method": method, "params": params}).to_string())
            .await;
        assert_eq!(reply["id"], self.next_id);
        reply
    }
}

async fn start() -> (Server, PathBuf) {
    let server = serve(PtyOptions::default()).await;
    let path = yarvis_server::control::start(server.state.clone())
        .await
        .unwrap();
    (server, path)
}

fn alarm(meet_link: Value) -> Value {
    json!({
        "alarm": {
            "id": "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b",
            "label": "Meeting: Standup",
            "fireAtMs": 1_760_000_000_000_i64,
            "sound": true,
            "meetLink": meet_link,
            "status": "fired",
            "source": "heads-down",
        }
    })
}

#[tokio::test]
async fn the_socket_is_private_to_the_user() {
    use std::os::unix::fs::PermissionsExt;
    let (_server, path) = start().await;
    let mode = std::fs::metadata(&path).unwrap().permissions().mode();
    assert_eq!(mode & 0o777, 0o600);
    let dir_mode = std::fs::metadata(path.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(dir_mode & 0o777, 0o700);
}

#[tokio::test]
async fn firing_and_releasing_an_alarm_become_events() {
    let (server, path) = start().await;
    let mut events = server.state.events.subscribe();
    let mut control = Control::connect(&path).await;

    let reply = control
        .call("alarm.fire", alarm(json!("https://meet.google.com/abc")))
        .await;
    assert_eq!(reply, json!({"id": 1, "ok": true}));
    let fired = events.recv().await.unwrap();
    assert_eq!(fired.kind, "alarm.fire");
    assert_eq!(fired.device_id, None);
    // The alarm as clients read it, without fields only the sidecar uses.
    assert_eq!(
        fired.data,
        json!({
            "id": "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b",
            "label": "Meeting: Standup",
            "fireAtMs": 1_760_000_000_000_i64,
            "sound": true,
            "meetLink": "https://meet.google.com/abc",
            "status": "fired",
        })
    );

    let reply = control
        .call(
            "alarm.release",
            json!({"id": "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b"}),
        )
        .await;
    assert_eq!(reply["ok"], true);
    let released = events.recv().await.unwrap();
    assert_eq!(released.kind, "alarm.release");
    assert_eq!(
        released.data,
        json!({"id": "0f8b5a4e-1c2d-4e3f-9a8b-7c6d5e4f3a2b"})
    );
}

#[tokio::test]
async fn a_refused_alarm_records_nothing() {
    let (server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call("alarm.fire", alarm(json!("file:///etc/passwd")))
        .await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "meetLink must be an http(s) link");
    let reply = control.call("alarm.release", json!({"id": "../x"})).await;
    assert_eq!(reply["ok"], false);
    assert!(server.state.events.since(0).await.unwrap().is_empty());
}

#[tokio::test]
async fn an_unknown_method_or_a_malformed_line_is_answered_with_an_error() {
    let (_server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control.call("pty.write", json!({})).await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "unknown method: pty.write");
    let reply = control.raw("{not json").await;
    assert_eq!(reply["id"], Value::Null);
    assert!(reply["error"].as_str().unwrap().starts_with("bad request"));
    // The connection survives both.
    assert_eq!(
        control
            .call("claude.kill", json!({"workspaceId": WORKSPACE}))
            .await["ok"],
        true
    );
}

#[tokio::test]
async fn a_request_line_over_the_limit_ends_the_connection() {
    let (_server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let huge = format!(
        "{{\"id\":1,\"method\":\"claude.kill\",\"params\":{{\"pad\":\"{}\"}}}}\n",
        "x".repeat(70 * 1024)
    );
    let _ = control.writer.write_all(huge.as_bytes()).await;
    let mut reply = String::new();
    let n = tokio::time::timeout(WAIT, control.reader.read_line(&mut reply))
        .await
        .expect("the server neither answered nor hung up")
        .unwrap_or(0);
    assert_eq!(n, 0, "expected the server to hang up, got {reply:?}");
}

#[tokio::test]
async fn github_save_token_writes_only_that_key() {
    let (server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call("github.saveToken", json!({"token": "gho_abc123"}))
        .await;
    assert_eq!(reply["ok"], true);
    let stored: Value =
        serde_json::from_str(&server.secrets.read_root().unwrap().unwrap()).unwrap();
    assert_eq!(stored, json!({"github_token": "gho_abc123"}));

    let reply = control
        .call("github.saveToken", json!({"token": "has space"}))
        .await;
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn mcp_save_oauth_writes_one_servers_oauth_subtree() {
    let (server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call(
            "mcp.saveOAuth",
            json!({"serverId": "srv-1", "oauth": {"access_token": "at"}}),
        )
        .await;
    assert_eq!(reply["ok"], true);
    let stored: Value =
        serde_json::from_str(&server.secrets.read_root().unwrap().unwrap()).unwrap();
    assert_eq!(
        stored["mcpServers"]["srv-1"]["oauth"],
        json!({"access_token": "at"})
    );

    // An id that could reach a sibling key is refused.
    let reply = control
        .call(
            "mcp.saveOAuth",
            json!({"serverId": "../github_token", "oauth": {"x": 1}}),
        )
        .await;
    assert_eq!(reply["ok"], false);
}

#[tokio::test]
async fn harness_run_env_refuses_a_blank_or_unknown_harness() {
    let (_server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control.call("harness.runEnv", json!({"harness": ""})).await;
    assert_eq!(reply["error"], "invalid harness id");
    let reply = control
        .call("harness.runEnv", json!({"harness": "nope"}))
        .await;
    assert_eq!(reply["ok"], false);
    assert!(reply.get("result").is_none());
}

/// A plain shell under the agent session's id, standing in for a workspace's
/// agent session.
async fn agent_shell(server: &Server) -> std::sync::Arc<yarvis_server::pty::session::Session> {
    let pty = server.state.pty.clone();
    let cwd = server.dir.path().to_string_lossy().into_owned();
    tokio::task::spawn_blocking(move || {
        pty.attach_or_spawn(
            &format!("ws-claude:{WORKSPACE}"),
            Size { cols: 80, rows: 24 },
            Some(cwd),
        )
    })
    .await
    .unwrap()
    .unwrap()
}

fn output_of(session: &yarvis_server::pty::session::Session) -> String {
    let attach = session.subscribe(u64::MAX, Some(0));
    session.detach(u64::MAX);
    String::from_utf8_lossy(&attach.catchup).into_owned()
}

#[tokio::test]
async fn claude_send_types_only_at_the_registered_agent() {
    let (server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let session = agent_shell(&server).await;
    let send = |instruction: &str, pids: Vec<u32>| json!({"workspaceId": WORKSPACE, "instruction": instruction, "agentPids": pids});

    // The bare shell holds the prompt, so nothing is typed.
    let reply = control.call("claude.send", send("echo hi", vec![])).await;
    assert_eq!(reply["ok"], false);
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("not what is reading")
    );

    // `exec` keeps the pid it printed, so `cat` leads the foreground under it.
    session
        .write(None, b"sh -c 'echo agent-pid=$$; exec cat'\n".to_vec())
        .await
        .unwrap();
    let pid: u32 = until("the stand-in agent to start", || {
        let session = session.clone();
        async move {
            let out = output_of(&session);
            // The last match is the output; the echoed command line, which
            // the shell may print twice, comes before it.
            let pid = out
                .rsplit("agent-pid=")
                .next()?
                .split_whitespace()
                .next()?
                .parse()
                .ok()?;
            (session.foreground_pid() == Some(pid)).then_some(pid)
        }
    })
    .await;

    // Still refused for a pid that isn't the one in the foreground.
    let reply = control
        .call("claude.send", send("hello there", vec![pid + 100_000]))
        .await;
    assert_eq!(reply["ok"], false);
    let reply = control
        .call("claude.send", send("!rm -rf /", vec![pid]))
        .await;
    assert_eq!(reply["ok"], false);
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("may not start with")
    );

    let reply = control
        .call("claude.send", send("hello\nthere", vec![pid]))
        .await;
    assert_eq!(reply, json!({"id": 4, "ok": true}));
    // `cat` echoes the submitted line back: the newline became a space and
    // the Enter came as its own write.
    until("cat to echo the instruction", || {
        let session = session.clone();
        async move { (output_of(&session).matches("hello there").count() >= 2).then_some(()) }
    })
    .await;

    // A slash command off the allowlist is refused; one on it is typed.
    let slash =
        |command: &str| json!({"workspaceId": WORKSPACE, "command": command, "agentPids": [pid]});
    let reply = control.call("claude.slash", slash("permissions")).await;
    assert!(reply["error"].as_str().unwrap().contains("never sends it"));
    let reply = control.call("claude.slash", slash("compact")).await;
    assert_eq!(reply["ok"], true);
    until("cat to echo the slash command", || {
        let session = session.clone();
        async move { (output_of(&session).matches("/compact").count() >= 2).then_some(()) }
    })
    .await;

    let reply = control
        .call("claude.kill", json!({"workspaceId": WORKSPACE}))
        .await;
    assert_eq!(reply["ok"], true);
    assert!(!server.state.pty.exists(&format!("ws-claude:{WORKSPACE}")));
}

#[tokio::test]
async fn claude_spawn_refuses_a_harness_the_assistant_may_not_start() {
    let (_server, path) = start().await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call(
            "claude.spawn",
            json!({"workspaceId": WORKSPACE, "cwd": "/tmp", "name": "n", "harness": "nope"}),
        )
        .await;
    assert_eq!(reply["ok"], false);
    assert_eq!(reply["error"], "no agent harness named \"nope\"");
    let reply = control
        .call(
            "claude.spawn",
            json!({"workspaceId": "a/b", "cwd": "/tmp", "name": "n"}),
        )
        .await;
    assert_eq!(reply["error"], "invalid workspaceId");
}
