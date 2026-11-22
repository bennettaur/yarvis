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

use common::pty::{Server, Setup, serve_with};
use common::{WAIT, until};
use yarvis_server::secret_store::memory::MemoryBackend;

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
    start_with(Setup::default()).await
}

async fn start_with(setup: Setup) -> (Server, PathBuf) {
    let server = serve_with(setup).await;
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
    let fired = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("no event in time")
        .unwrap();
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
    let released = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("no event in time")
        .unwrap();
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

/// A store already holding other secrets, so a write that replaced the whole
/// blob instead of its one key would show.
fn seeded() -> (std::sync::Arc<MemoryBackend>, Value) {
    let blob = json!({
        "anthropic_api_key": "sk-ant",
        "mcpServers": {
            "srv-1": {"headers": {"X-Key": "h1"}},
            "srv-2": {"headers": {"X-Key": "h2"}, "oauth": {"access_token": "old"}},
        },
    });
    (MemoryBackend::holding(&blob.to_string()), blob)
}

fn stored(server: &Server) -> Value {
    serde_json::from_str(&server.secrets.read_root().unwrap().unwrap()).unwrap()
}

#[tokio::test]
async fn github_save_token_writes_only_that_key() {
    let (store, mut expected) = seeded();
    let (server, path) = start_with(Setup {
        secrets: Some(store),
        ..Setup::default()
    })
    .await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call("github.saveToken", json!({"token": "gho_abc123"}))
        .await;
    assert_eq!(reply["ok"], true);
    expected["github_token"] = json!("gho_abc123");
    assert_eq!(stored(&server), expected);

    let reply = control
        .call("github.saveToken", json!({"token": "has space"}))
        .await;
    assert_eq!(reply["ok"], false);
    assert_eq!(stored(&server), expected);
}

#[tokio::test]
async fn mcp_save_oauth_writes_one_servers_oauth_subtree() {
    let (store, mut expected) = seeded();
    let (server, path) = start_with(Setup {
        secrets: Some(store),
        ..Setup::default()
    })
    .await;
    let mut control = Control::connect(&path).await;
    let reply = control
        .call(
            "mcp.saveOAuth",
            json!({"serverId": "srv-1", "oauth": {"access_token": "at"}}),
        )
        .await;
    assert_eq!(reply["ok"], true);
    expected["mcpServers"]["srv-1"]["oauth"] = json!({"access_token": "at"});
    assert_eq!(stored(&server), expected);

    // An id that could reach a sibling key is refused, and nothing changes.
    let reply = control
        .call(
            "mcp.saveOAuth",
            json!({"serverId": "../github_token", "oauth": {"x": 1}}),
        )
        .await;
    assert_eq!(reply["ok"], false);
    assert_eq!(stored(&server), expected);
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

/// Starts `cat` in the session under a pid it prints first, and returns that
/// pid once `cat` leads the terminal's foreground.
async fn stand_in_agent(session: &std::sync::Arc<yarvis_server::pty::session::Session>) -> u32 {
    // `exec` keeps the pid it printed, so `cat` leads the foreground under it.
    session
        .write(None, b"sh -c 'echo agent-pid=$$; exec cat'\n".to_vec())
        .await
        .unwrap();
    until("the stand-in agent to start", || {
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
    .await
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

    let pid = stand_in_agent(&session).await;

    // Still refused for a pid that isn't the one in the foreground.
    let reply = control
        .call("claude.send", send("hello there", vec![pid + 100_000]))
        .await;
    // `cat` matches neither the pid nor the session's program (it has none).
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("not what is reading")
    );
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
    // `cat` prints the submitted line after the terminal's own echo of it,
    // with the newline turned into a space.
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

#[tokio::test]
async fn client_input_waits_until_an_agent_send_has_pressed_enter() {
    let (server, path) = start_with(Setup {
        pty: PtyOptions {
            // Long enough that the client's write surely lands in the pause.
            submit_delay: std::time::Duration::from_secs(2),
            ..PtyOptions::default()
        },
        ..Setup::default()
    })
    .await;
    let session = agent_shell(&server).await;
    let pid = stand_in_agent(&session).await;
    let send = tokio::spawn(async move {
        let mut control = Control::connect(&path).await;
        control
            .call(
                "claude.send",
                json!({"workspaceId": WORKSPACE, "instruction": "hello there", "agentPids": [pid]}),
            )
            .await
    });
    // The text is typed (the terminal echoes it) but not yet submitted.
    until("the instruction to be typed", || {
        let session = session.clone();
        async move { output_of(&session).contains("hello there").then_some(()) }
    })
    .await;
    let typing = session.clone();
    let write = tokio::spawn(async move { typing.write(Some(1), b"X\r".to_vec()).await });
    assert_eq!(send.await.unwrap()["ok"], true);
    write.await.unwrap().unwrap();
    until("cat to print both lines", || {
        let session = session.clone();
        async move { (output_of(&session).matches('X').count() >= 2).then_some(()) }
    })
    .await;
    let out = output_of(&session);
    assert!(
        !out.contains("hello thereX"),
        "the client's keys landed inside the instruction: {out:?}"
    );
    assert!(out.matches("hello there").count() >= 2, "{out:?}");
}

#[tokio::test]
async fn a_send_whose_agent_exits_during_the_pause_is_not_submitted() {
    let (server, path) = start_with(Setup {
        pty: PtyOptions {
            submit_delay: std::time::Duration::from_secs(2),
            ..PtyOptions::default()
        },
        ..Setup::default()
    })
    .await;
    let session = agent_shell(&server).await;
    let pid = stand_in_agent(&session).await;
    let send = tokio::spawn(async move {
        let mut control = Control::connect(&path).await;
        control
            .call(
                "claude.send",
                json!({"workspaceId": WORKSPACE, "instruction": "hello there", "agentPids": [pid]}),
            )
            .await
    });
    until("the instruction to be typed", || {
        let session = session.clone();
        async move { output_of(&session).contains("hello there").then_some(()) }
    })
    .await;
    let killed = std::process::Command::new("kill")
        .arg(pid.to_string())
        .status()
        .unwrap();
    assert!(killed.success());
    let reply = send.await.unwrap();
    assert_eq!(reply["ok"], false);
    assert!(
        reply["error"]
            .as_str()
            .unwrap()
            .contains("typed but not submitted"),
        "{reply}"
    );
}

/// The session `id` holds now, without spawning one.
async fn live_session(
    server: &Server,
    id: &str,
) -> Option<std::sync::Arc<yarvis_server::pty::session::Session>> {
    if !server.state.pty.exists(id) {
        return None;
    }
    let (pty, id) = (server.state.pty.clone(), id.to_string());
    tokio::task::spawn_blocking(move || {
        pty.attach_or_spawn(
            &id,
            Size {
                cols: 120,
                rows: 32,
            },
            None,
        )
    })
    .await
    .unwrap()
    .ok()
}

/// A review workspace's Ask Claude session: started over the socket in its
/// own folder with the files it reads, left alone while it runs, replaced
/// once it has exited, and ended by `claude.killReview`. A fake `claude`
/// prints its arguments and exits on the first line it reads.
#[tokio::test]
async fn claude_spawn_review_starts_one_session_and_kill_review_ends_it() {
    let (server, path) = start().await;
    let mut control = Control::connect(&path).await;
    // Real paths, since the core compares the folders as real paths.
    let root = std::fs::canonicalize(server.dir.path()).unwrap();
    let cwd = root.join(".review-sessions").join(WORKSPACE);
    let checkout = root.join(".review").join(WORKSPACE).join("pr1");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&checkout).unwrap();
    let bin = root.join("bin");
    std::fs::create_dir(&bin).unwrap();
    let claude = bin.join("claude");
    std::fs::write(
        &claude,
        "#!/bin/sh\necho \"fake-claude $*\"\nread -r line\n",
    )
    .unwrap();
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&claude, std::fs::Permissions::from_mode(0o755)).unwrap();
    let id = format!("review-claude:{WORKSPACE}");
    let spawn = json!({
        "workspaceId": WORKSPACE,
        "cwd": cwd,
        "addDirs": [checkout],
        "settings": "{\"disableAllHooks\":true}",
        "context": "github/o/r/1 in pr1.",
        "loadRepoConfig": false,
    });

    // The lockdown is made of Claude Code flags, so another agent is refused.
    server.write_settings(json!({ "agentCommand": "cat" }));
    let reply = control.call("claude.spawnReview", spawn.clone()).await;
    assert!(
        reply["error"].as_str().unwrap().contains("not Claude Code"),
        "{reply}"
    );
    assert!(!server.state.pty.exists(&id));

    server.write_settings(json!({ "agentCommand": claude.to_string_lossy() }));
    let reply = control.call("claude.spawnReview", spawn.clone()).await;
    assert_eq!(reply["ok"], true, "{reply}");
    let first = live_session(&server, &id).await.expect("a running session");
    until("the fake claude to start", || {
        let first = first.clone();
        async move {
            output_of(&first)
                .contains("fake-claude --setting-sources user")
                .then_some(())
        }
    })
    .await;
    let files = root.join(".review").join(WORKSPACE).join(".ask-claude");
    let settings: Value =
        serde_json::from_str(&std::fs::read_to_string(files.join("settings.json")).unwrap())
            .unwrap();
    assert_eq!(settings["disableAllHooks"], true);
    assert_eq!(
        settings["permissions"]["additionalDirectories"],
        json!([checkout])
    );
    let prompt = std::fs::read_to_string(files.join("system-prompt.md")).unwrap();
    assert!(prompt.ends_with("github/o/r/1 in pr1."), "{prompt}");

    // A start while it runs leaves it alone.
    let reply = control.call("claude.spawnReview", spawn.clone()).await;
    assert_eq!(reply["ok"], true);
    let again = live_session(&server, &id).await.unwrap();
    assert!(std::sync::Arc::ptr_eq(&first, &again));

    // Once it has exited, a start replaces it.
    first.write(None, b"\n".to_vec()).await.unwrap();
    until("the fake claude to exit", || {
        let running = first.is_running();
        async move { (!running).then_some(()) }
    })
    .await;
    let reply = control.call("claude.spawnReview", spawn).await;
    assert_eq!(reply["ok"], true);
    let replaced = live_session(&server, &id).await.expect("a new session");
    assert!(!std::sync::Arc::ptr_eq(&first, &replaced));

    let reply = control
        .call("claude.killReview", json!({ "workspaceId": WORKSPACE }))
        .await;
    assert_eq!(reply["ok"], true);
    assert!(!server.state.pty.exists(&id));
    until("the session to end", || {
        let running = replaced.is_running();
        async move { (!running).then_some(()) }
    })
    .await;
    let reply = control
        .call("claude.killReview", json!({ "workspaceId": "a/b" }))
        .await;
    assert_eq!(reply["error"], "invalid workspaceId");
}
