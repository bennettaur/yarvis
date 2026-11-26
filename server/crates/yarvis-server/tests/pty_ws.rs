//! The `/api/pty/{id}` WebSocket and the PTY core commands, against a real
//! `/bin/sh`. These open PTYs, which Claude Code's sandbox refuses, so run
//! them outside it.

mod common;

use axum::body::Body;
use axum::http::Request;
use futures_util::{SinkExt, StreamExt};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use tokio_tungstenite::tungstenite::Message;
use tower::ServiceExt;
use yarvis_server::app;
use yarvis_server::auth::Scope;
use yarvis_server::pty::PtyOptions;

use common::pty::{Server, Setup, device, serve, serve_with};
use common::{WAIT, until};
use yarvis_server::config::SshAgentConfig;

type Socket =
    tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

/// One attached client, and everything it has been sent.
struct Client {
    socket: Socket,
    /// The output bytes received since the last snapshot, in stream order.
    output: Vec<u8>,
    /// Offset one past the last byte received.
    next: Option<u64>,
    texts: Vec<Value>,
    close_code: Option<u16>,
    /// Counts snapshots, each of which replaces `output`.
    snapshots: usize,
}

impl Client {
    async fn connect(server: &Server, id: &str, hello: Value) -> Self {
        let url = format!("ws://{}/api/pty/{}", server.addr, urlencode(id));
        let (mut socket, _) = tokio_tungstenite::connect_async(url).await.unwrap();
        socket
            .send(Message::Text(hello.to_string().into()))
            .await
            .unwrap();
        Self {
            socket,
            output: Vec::new(),
            next: None,
            texts: Vec::new(),
            close_code: None,
            snapshots: 0,
        }
    }

    /// Reads one message, checking every output frame starts where the last
    /// one ended. `false` once the socket has ended.
    async fn read_one(&mut self) -> bool {
        let msg = tokio::time::timeout(WAIT, self.socket.next())
            .await
            .expect("no message in time");
        match msg {
            Some(Ok(Message::Binary(b))) => {
                let offset = u64::from_be_bytes(b[..8].try_into().unwrap());
                let bytes = &b[8..];
                let attached = self
                    .texts
                    .last()
                    .is_some_and(|t| t["type"] == "attached" || t["type"] == "resync");
                match self.next {
                    // The catch-up frame after `attached` starts where it says.
                    Some(next) if !attached => {
                        assert_eq!(offset, next, "gap or overlap in the stream")
                    }
                    _ => {}
                }
                if attached {
                    let t = self.texts.last().unwrap();
                    assert_eq!(offset, t["startOffset"].as_u64().unwrap());
                    if t["mode"] == "snapshot" {
                        self.output.clear();
                        self.snapshots += 1;
                    }
                    // Marks the catch-up as consumed for the check above.
                    self.texts.push(json!({"type": "catchup"}));
                }
                self.output.extend_from_slice(bytes);
                self.next = Some(offset + bytes.len() as u64);
                true
            }
            Some(Ok(Message::Text(t))) => {
                let t: Value = serde_json::from_str(&t).unwrap();
                // A resync picks up from the last byte this client got, so a
                // resume must start exactly there and a snapshot must count
                // the gap it leaves.
                if t["type"] == "resync" {
                    let next = self.next.expect("a resync before any output");
                    assert_eq!(t["requestedOffset"], next);
                    let start = t["startOffset"].as_u64().unwrap();
                    match t["mode"].as_str() {
                        Some("resume") => assert_eq!(start, next),
                        _ => assert_eq!(t["lostBytes"].as_u64().unwrap(), start - next),
                    }
                }
                self.texts.push(t);
                true
            }
            Some(Ok(Message::Close(frame))) => {
                self.close_code = Some(frame.map_or(1005, |f| u16::from(f.code)));
                false
            }
            Some(Ok(_)) => true,
            None | Some(Err(_)) => false,
        }
    }

    /// Reads until the output so far contains `needle`. Only the bytes not
    /// yet searched are looked at, since a flood test receives megabytes.
    async fn wait_for_output(&mut self, needle: &str) {
        let needle = needle.as_bytes();
        let mut from = 0;
        let mut snapshots = self.snapshots;
        loop {
            if self.snapshots != snapshots {
                (from, snapshots) = (0, self.snapshots);
            }
            let from_here = from.min(self.output.len());
            if self.output[from_here..]
                .windows(needle.len())
                .any(|w| w == needle)
            {
                return;
            }
            from = self.output.len().saturating_sub(needle.len() - 1);
            assert!(
                self.read_one().await,
                "socket ended before {:?} arrived",
                String::from_utf8_lossy(needle)
            );
        }
    }

    /// Reads until a text message of `kind` arrives, and returns it.
    async fn wait_for_text(&mut self, kind: &str) -> Value {
        let seen = self.texts.len();
        loop {
            if let Some(t) = self.texts[seen..].iter().find(|t| t["type"] == kind) {
                return t.clone();
            }
            assert!(self.read_one().await, "socket ended before {kind:?}");
        }
    }

    /// Reads until the server closes the socket, and returns the close code.
    async fn wait_for_close(&mut self) -> u16 {
        while self.read_one().await {}
        self.close_code
            .expect("the socket ended without a close frame")
    }

    async fn input(&mut self, text: &str) {
        let msg = json!({"type": "input", "data": text}).to_string();
        self.socket.send(Message::Text(msg.into())).await.unwrap();
    }

    async fn send_json(&mut self, v: Value) {
        self.socket
            .send(Message::Text(v.to_string().into()))
            .await
            .unwrap();
    }
}

fn urlencode(id: &str) -> String {
    id.bytes()
        .map(|b| match b {
            b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'-' | b'_' | b'.' => (b as char).to_string(),
            _ => format!("%{b:02X}"),
        })
        .collect()
}

fn hello(token: &str, server: &Server) -> Value {
    json!({
        "type": "auth",
        "token": token,
        "cols": 100,
        "rows": 30,
        "cwd": server.dir.path(),
    })
}

/// A command whose output differs from its echo, so seeing the output proves
/// the shell ran it.
fn marker(tag: &str) -> (String, String) {
    (
        format!("printf '%s-%s\\n' {tag} done\n"),
        format!("{tag}-done"),
    )
}

async fn core(server: &Server, token: &str, command: &str, body: Value) -> (u16, Value) {
    let response = app(server.state.clone())
        .oneshot(
            Request::post(format!("/api/core/{command}"))
                .header("authorization", format!("Bearer {token}"))
                .header("content-type", "application/json")
                .header("host", "localhost:7878")
                .body(Body::from(body.to_string()))
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    let value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
    (status, value)
}

#[tokio::test]
async fn attaching_spawns_a_shell_and_streams_its_output() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    let attached = client.wait_for_text("attached").await;
    assert_eq!(attached["mode"], "snapshot");
    assert_eq!(attached["startOffset"], 0);
    assert_eq!(attached["lostBytes"], 0);
    assert_eq!(attached["exit"], Value::Null);

    let (command, output) = marker("first");
    client.input(&command).await;
    client.wait_for_output(&output).await;
    // Binary input counts the same as JSON input.
    let (command, output) = marker("binary");
    client
        .socket
        .send(Message::Binary(command.into_bytes().into()))
        .await
        .unwrap();
    client.wait_for_output(&output).await;
}

#[tokio::test]
async fn a_client_resuming_from_its_offset_gets_exactly_what_it_missed() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut first = Client::connect(&server, id, hello(&token, &server)).await;
    let (command, output) = marker("before");
    first.input(&command).await;
    first.wait_for_output(&output).await;
    let left_at = first.next.unwrap();
    drop(first);

    // Output the dropped client never saw.
    let (command, missed) = marker("missed");
    let (status, _) = core(
        &server,
        &token,
        "pty_write",
        json!({"id": id, "data": command}),
    )
    .await;
    assert_eq!(status, 204);
    let mut watcher = Client::connect(&server, id, hello(&token, &server)).await;
    watcher.wait_for_output(&missed).await;

    let mut back = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "offset": left_at, "cols": 100, "rows": 30}),
    )
    .await;
    let attached = back.wait_for_text("attached").await;
    assert_eq!(attached["mode"], "resume");
    assert_eq!(attached["startOffset"], left_at);
    assert_eq!(attached["requestedOffset"], left_at);
    assert_eq!(attached["lostBytes"], 0);
    assert!(attached["endOffset"].as_u64().unwrap() >= left_at);
    back.wait_for_output(&missed).await;
    // The watcher replayed the whole stream from 0, so what the resumed
    // client got must be that stream's bytes from `left_at` on.
    let tail = &watcher.output[left_at as usize..];
    let shared = tail.len().min(back.output.len());
    assert_eq!(back.output[..shared], tail[..shared]);
    assert!(!String::from_utf8_lossy(&back.output).contains("before-done"));
}

#[tokio::test]
async fn an_offset_older_than_the_scrollback_gets_a_flagged_snapshot() {
    let server = serve(PtyOptions {
        scrollback_cap: 512,
        ..PtyOptions::default()
    })
    .await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut first = Client::connect(&server, id, hello(&token, &server)).await;
    first
        .input("i=0; while [ $i -lt 100 ]; do echo line-$i; i=$((i+1)); done; echo all-done-$((1+1))\n")
        .await;
    first.wait_for_output("all-done-2").await;
    let end = first.next.unwrap();
    assert!(end > 512);

    let mut back = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "offset": 0, "cols": 100, "rows": 30}),
    )
    .await;
    let attached = back.wait_for_text("attached").await;
    assert_eq!(attached["mode"], "snapshot");
    let start = attached["startOffset"].as_u64().unwrap();
    assert!(start > 0);
    assert_eq!(attached["lostBytes"].as_u64().unwrap(), start);
    let kept = attached["endOffset"].as_u64().unwrap() - start;
    assert_eq!(kept, 512);
    back.wait_for_output("all-done-2").await;
}

#[tokio::test]
async fn two_clients_see_the_same_stream_and_either_can_type() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut a = Client::connect(&server, id, hello(&token, &server)).await;
    let (command, output) = marker("from-a");
    a.input(&command).await;
    a.wait_for_output(&output).await;

    let mut b = Client::connect(&server, id, hello(&token, &server)).await;
    b.wait_for_output(&output).await;
    let (command, output) = marker("from-b");
    b.input(&command).await;
    b.wait_for_output(&output).await;
    a.wait_for_output(&output).await;

    // Both rebuilt the same bytes from offset 0, the catch-up and live output
    // joined with no gap or duplicate (checked frame by frame in `read_one`).
    let a_end = a.next.unwrap();
    while b.next.unwrap() < a_end {
        assert!(b.read_one().await);
    }
    while a.next.unwrap() < b.next.unwrap() {
        assert!(a.read_one().await);
    }
    let shared = a.output.len().min(b.output.len());
    assert_eq!(a.output[..shared], b.output[..shared]);
}

#[tokio::test]
async fn the_first_client_owns_the_size_and_a_later_one_waits_its_turn() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut a = Client::connect(&server, id, hello(&token, &server)).await;
    let attached = a.wait_for_text("attached").await;
    let a_id = attached["clientId"].clone();
    assert_eq!(attached["owner"], a_id);
    a.input("stty size\n").await;
    a.wait_for_output("30 100").await;

    let mut b = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "cols": 60, "rows": 20}),
    )
    .await;
    let b_attached = b.wait_for_text("attached").await;
    // B's viewport is recorded, not applied, while A owns the size.
    assert_eq!(b_attached["owner"], a_id);
    assert_eq!(b_attached["cols"], 100);
    assert_eq!(b_attached["rows"], 30);

    // Once A leaves nobody owns the size, and B typing takes it with B's
    // recorded viewport.
    drop(a);
    loop {
        let size = b.wait_for_text("size").await;
        if size["owner"].is_null() {
            break;
        }
    }
    b.input("stty size\n").await;
    b.wait_for_output("20 60").await;
}

#[tokio::test]
async fn focus_and_resize_move_the_size_to_that_client() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut a = Client::connect(&server, id, hello(&token, &server)).await;
    a.wait_for_text("attached").await;
    let mut b = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "cols": 60, "rows": 20}),
    )
    .await;
    let b_id = b.wait_for_text("attached").await["clientId"].clone();

    b.send_json(json!({"type": "focus"})).await;
    let size = loop {
        let size = a.wait_for_text("size").await;
        if size["owner"] == b_id {
            break size;
        }
    };
    assert_eq!(
        (size["cols"].clone(), size["rows"].clone()),
        (json!(60), json!(20))
    );
    b.input("stty size\n").await;
    b.wait_for_output("20 60").await;

    // The owner's later viewport applies at once.
    b.send_json(json!({"type": "resize", "cols": 70, "rows": 22}))
        .await;
    loop {
        let size = a.wait_for_text("size").await;
        if size["cols"] == 70 {
            assert_eq!(size["rows"], 22);
            break;
        }
    }
}

#[tokio::test]
async fn a_terminal_answering_a_query_does_not_take_the_size() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut a = Client::connect(&server, id, hello(&token, &server)).await;
    a.wait_for_text("attached").await;
    let mut b = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "cols": 60, "rows": 20}),
    )
    .await;
    let b_id = b.wait_for_text("attached").await["clientId"].clone();

    // A reply only shows in A's output once the PTY has it, and any size
    // change it made goes out before the write. `cat` keeps the shell's line
    // editor from eating the escape sequences, so the tty echoes them; the
    // marker prints from inside the process that becomes `cat`, after the
    // shell has handed the tty over.
    a.input("sh -c \"printf '%s-%s\\n' cat-ready done; exec cat -v\"\n")
        .await;
    a.wait_for_output("cat-ready-done").await;

    // B's terminal answers a background-colour query and a device-attributes
    // query, as every attached terminal does. A keeps the size.
    b.input("\x1b]11;rgb:1234/1234/1234\x1b\\\x1b[?1;2c").await;
    a.wait_for_output("rgb:1234/1234/1234").await;
    assert!(
        !a.texts
            .iter()
            .any(|t| t["type"] == "size" && t["owner"] == b_id),
        "a reply took over the size"
    );

    // B typing still takes it.
    b.input("x").await;
    loop {
        let size = a.wait_for_text("size").await;
        if size["owner"] == b_id {
            assert_eq!(size["cols"], 60);
            break;
        }
    }
}

#[tokio::test]
async fn revoking_the_device_closes_its_terminal() {
    let server = serve(PtyOptions::default()).await;
    let (phone, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    server.state.auth.announce_revocation(&phone);
    assert_eq!(client.wait_for_close().await, 4401);
}

#[tokio::test]
async fn a_read_only_device_cannot_attach() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Read]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    assert_eq!(client.wait_for_close().await, 4403);
    assert!(!server.state.pty.exists("tab:terminal/t1/p1"));
}

/// `chat` sends messages; only `terminal` gets a shell.
#[tokio::test]
async fn a_chat_device_gets_no_shell() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Read, Scope::Chat]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    assert_eq!(client.wait_for_close().await, 4403);
    assert!(!server.state.pty.exists("tab:terminal/t1/p1"));
    for (command, args) in [
        (
            "pty_write",
            json!({"id": "tab:terminal/t1/p1", "data": "x"}),
        ),
        ("pty_kill", json!({"id": "tab:terminal/t1/p1"})),
        (
            "pty_resize",
            json!({"id": "tab:terminal/t1/p1", "cols": 90, "rows": 25}),
        ),
        (
            "pty_start_claude",
            json!({"id": "ws-claude:w1", "cwd": "/tmp"}),
        ),
        ("get_agent_config", json!({})),
    ] {
        let (status, body) = core(&server, &token, command, args).await;
        assert_eq!(status, 403, "{command}: {body}");
    }
}

#[tokio::test]
async fn a_malformed_hello_is_refused_without_spawning() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(
        &server,
        "tab:terminal/t1/p1",
        json!({"type": "auth", "token": token, "offset": -5}),
    )
    .await;
    assert_eq!(client.wait_for_close().await, 4400);
    assert!(!server.state.pty.exists("tab:terminal/t1/p1"));
}

#[tokio::test]
async fn a_review_id_never_gets_a_plain_shell() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "review-claude:ws1", hello(&token, &server)).await;
    let error = client.wait_for_text("error").await;
    assert_eq!(error["error"], "the review session has ended");
    assert_eq!(client.wait_for_close().await, 4400);
}

#[tokio::test]
async fn an_exit_reaches_clients_after_the_last_byte_and_the_event_log() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut events = server.state.events.subscribe();
    let id = "tab:terminal/t1/p1";
    let mut client = Client::connect(&server, id, hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    client.input("echo bye-$((40+2)); exit 3\n").await;
    let exit = client.wait_for_text("exit").await;
    assert_eq!(exit["code"], 3);
    assert!(String::from_utf8_lossy(&client.output).contains("bye-42"));
    assert_eq!(client.wait_for_close().await, 1000);

    let event = tokio::time::timeout(WAIT, async {
        loop {
            let event = events.recv().await.unwrap();
            if event.kind != "pty.started" {
                return event;
            }
        }
    })
    .await
    .expect("no event in time");
    assert_eq!(event.kind, "pty.exited");
    assert_eq!(event.data, json!({"id": id, "code": 3}));
    assert_eq!(event.device_id, None);
    assert!(!server.state.pty.exists(id));

    // Attaching again starts a fresh shell that carries on the offsets.
    let ended_at = client.next.unwrap();
    let mut again = Client::connect(
        &server,
        id,
        json!({"type": "auth", "token": token, "offset": ended_at, "cols": 100, "rows": 30}),
    )
    .await;
    let attached = again.wait_for_text("attached").await;
    assert_eq!(attached["mode"], "resume");
    assert_eq!(attached["startOffset"], ended_at);
    let (command, output) = marker("reborn");
    again.input(&command).await;
    again.wait_for_output(&output).await;
}

#[tokio::test]
async fn the_core_commands_drive_and_report_on_a_session() {
    let server = serve(PtyOptions::default()).await;
    let (_, terminal) = device(&server.state, &[Scope::Read, Scope::Terminal]).await;
    let (_, reader) = device(&server.state, &[Scope::Read]).await;
    let id = "tab:terminal/t1/p1";

    assert_eq!(
        core(&server, &reader, "pty_exists", json!({"id": id})).await,
        (200, json!(false))
    );
    let mut client = Client::connect(&server, id, hello(&terminal, &server)).await;
    client.wait_for_text("attached").await;
    assert_eq!(
        core(&server, &reader, "pty_exists", json!({"id": id})).await,
        (200, json!(true))
    );
    // A read device can look but not type.
    let (status, _) = core(
        &server,
        &reader,
        "pty_write",
        json!({"id": id, "data": "x"}),
    )
    .await;
    assert_eq!(status, 403);

    assert_eq!(
        core(&server, &reader, "pty_is_busy", json!({"id": id})).await,
        (200, json!(false))
    );
    client.input("sleep 30\n").await;
    until("the shell to hand the foreground to sleep", || {
        let server = &server;
        let reader = reader.clone();
        async move {
            let (_, busy) = core(server, &reader, "pty_is_busy", json!({"id": id})).await;
            (busy == json!(true)).then_some(())
        }
    })
    .await;

    assert_eq!(
        core(
            &server,
            &terminal,
            "pty_resize",
            json!({"id": id, "cols": 90, "rows": 25})
        )
        .await,
        (204, Value::Null)
    );
    loop {
        let size = client.wait_for_text("size").await;
        if size["cols"] == 90 {
            assert_eq!(size["rows"], 25);
            break;
        }
    }

    let (status, body) = core(
        &server,
        &terminal,
        "pty_write",
        json!({"id": id, "data": "x".repeat(64 * 1024 + 1)}),
    )
    .await;
    assert_eq!(status, 400);
    assert!(body["error"].as_str().unwrap().contains("exceeds"));

    assert_eq!(
        core(&server, &reader, "pty_session_harness", json!({"id": id})).await,
        (200, Value::Null)
    );
    let (status, config) = core(&server, &terminal, "get_agent_config", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(config["defaultHarness"], "claude");
    assert_eq!(config["harnesses"][0]["id"], "claude");

    assert_eq!(
        core(&server, &terminal, "pty_kill", json!({"id": id})).await,
        (204, Value::Null)
    );
    client.wait_for_text("exit").await;
    assert_eq!(
        core(&server, &reader, "pty_exists", json!({"id": id})).await,
        (200, json!(false))
    );
    let (status, _) = core(&server, &terminal, "pty_attach", json!({"id": id})).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_client_that_stops_reading_is_resynced_without_holding_up_the_other() {
    let server = serve(PtyOptions {
        client_queue: 2,
        // The slow client's sends stay blocked until the fast one has read
        // the whole flood, which a slow runner may take a while over.
        send_timeout: std::time::Duration::from_secs(120),
        ..PtyOptions::default()
    })
    .await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let id = "tab:terminal/t1/p1";
    let mut fast = Client::connect(&server, id, hello(&token, &server)).await;
    fast.wait_for_text("attached").await;
    let mut slow = Client::connect(&server, id, hello(&token, &server)).await;
    slow.wait_for_text("attached").await;

    // Far more than the socket buffers hold, so the slow client's queue fills
    // while it isn't reading.
    fast.input("yes | head -c 5000000; echo; echo flood-$((1+1))\n")
        .await;
    fast.wait_for_output("flood-2").await;

    slow.wait_for_output("flood-2").await;
    // `read_one` checked each resync's offsets against what it had received.
    assert!(
        slow.texts.iter().any(|t| t["type"] == "resync"),
        "the slow client was never resynced"
    );
}

#[tokio::test]
async fn every_core_command_needs_its_scope() {
    let server = serve(PtyOptions::default()).await;
    let (_, reader) = device(&server.state, &[Scope::Read]).await;
    let (_, terminal) = device(&server.state, &[Scope::Terminal]).await;
    let id = json!({"id": "tab:terminal/t1/p1"});
    for command in [
        "pty_write",
        "pty_resize",
        "pty_kill",
        "pty_start_claude",
        "get_agent_config",
    ] {
        let (status, _) = core(&server, &reader, command, id.clone()).await;
        assert_eq!(status, 403, "{command}");
    }
    for command in ["pty_exists", "pty_is_busy", "pty_session_harness"] {
        let (status, _) = core(&server, &terminal, command, id.clone()).await;
        assert_eq!(status, 403, "{command}");
        let (status, _) = core(&server, &reader, command, id.clone()).await;
        assert_eq!(status, 200, "{command}");
    }
    let (status, _) = core(&server, "", "pty_exists", id.clone()).await;
    assert_eq!(status, 401);

    let (status, body) = core(
        &server,
        &terminal,
        "pty_write",
        json!({"id": "nope", "data": "x"}),
    )
    .await;
    assert_eq!(
        (status, body["error"].clone()),
        (400, json!("no such session"))
    );
    let (status, _) = core(
        &server,
        &terminal,
        "pty_resize",
        json!({"id": "nope", "cols": 0, "rows": 24}),
    )
    .await;
    assert_eq!(status, 400);
    let (status, body) = core(
        &server,
        &terminal,
        "pty_start_claude",
        json!({"workspaceId": "../x", "cwd": "/tmp", "name": "n", "remoteControl": false}),
    )
    .await;
    assert_eq!(
        (status, body["error"].clone()),
        (400, json!("invalid workspaceId"))
    );
}

#[tokio::test]
async fn pty_start_claude_launches_the_configured_agent() {
    let server = serve(PtyOptions::default()).await;
    // `cat` stands in for Claude Code: the launch line is the bare command.
    server.write_settings(json!({"agentCommand": "cat", "agentName": "Cat"}));
    let (_, token) = device(&server.state, &[Scope::Read, Scope::Terminal]).await;
    let workspace = "0b6a3f1e-9c1d-4e55-8a5b-2f3c4d5e6f70";
    let cwd = server.dir.path().to_string_lossy().into_owned();
    let (status, _) = core(
        &server,
        &token,
        "pty_start_claude",
        json!({"workspaceId": workspace, "cwd": cwd, "name": "Fix it", "remoteControl": false}),
    )
    .await;
    assert_eq!(status, 204);
    let id = format!("ws-claude:{workspace}");
    assert_eq!(
        core(&server, &token, "pty_session_harness", json!({"id": id})).await,
        (200, json!({"id": "claude", "name": "Cat"}))
    );
    let (_, config) = core(&server, &token, "get_agent_config", json!({})).await;
    assert_eq!(config["command"], "cat");
    until("cat to hold the terminal", || {
        let busy = server.state.pty.is_busy(&id);
        async move { busy.then_some(()) }
    })
    .await;

    let (status, body) = get(&server, &token, "/api/pty").await;
    assert_eq!(status, 200, "{body}");
    let row = body["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["id"] == id.as_str())
        .unwrap_or_else(|| panic!("no row for {id}: {body}"))
        .clone();
    assert_eq!(row["kind"], "agent");
    assert_eq!(row["workspaceId"], workspace);
    assert_eq!(row["harness"], json!({"id": "claude", "name": "Cat"}));
    assert_eq!(row["cwd"], cwd.as_str());
}

#[tokio::test]
async fn revoking_another_device_leaves_this_terminal_open() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let (other, _) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    server.state.auth.announce_revocation(&other);
    let (command, output) = marker("still-here");
    client.input(&command).await;
    client.wait_for_output(&output).await;
}

#[tokio::test]
async fn the_session_cap_refuses_one_more_shell() {
    let server = serve(PtyOptions::default()).await;
    server.write_settings(json!({"maxPtySessions": 1}));
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut first = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    first.wait_for_text("attached").await;
    let mut second = Client::connect(&server, "tab:terminal/t1/p2", hello(&token, &server)).await;
    let error = second.wait_for_text("error").await;
    assert!(
        error["error"]
            .as_str()
            .unwrap()
            .contains("too many PTY sessions")
    );
    assert_eq!(second.wait_for_close().await, 4400);
    // The id already held still attaches.
    let mut again = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    again.wait_for_text("attached").await;
}

#[tokio::test]
async fn input_over_the_write_limit_closes_the_socket() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    client.input(&"x".repeat(64 * 1024 + 1)).await;
    assert_eq!(client.wait_for_close().await, 4400);
}

/// What `$SSH_AUTH_SOCK` a fresh shell sees. `server_agent` replaces the
/// socket the server set from its config, when given.
async fn ssh_auth_sock_seen_with(ssh_agent: SshAgentConfig, server_agent: Option<&str>) -> String {
    let server = serve_with(Setup {
        ssh_agent,
        ..Setup::default()
    })
    .await;
    if let Some(socket) = server_agent {
        server.state.pty.set_server_ssh_agent(Some(socket.into()));
    }
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    client
        .input("printf 'sock=[%s]\\n' \"$SSH_AUTH_SOCK\"\n")
        .await;
    // The echoed command line holds `%s`, so only the output matches `sock=[/`
    // or `sock=[]`.
    loop {
        let out = String::from_utf8_lossy(&client.output).into_owned();
        let printed = out
            .split("sock=[")
            .skip(1)
            .find(|rest| !rest.starts_with('%'));
        if let Some(end) = printed.and_then(|rest| rest.find(']')) {
            return printed.unwrap()[..end].to_string();
        }
        assert!(client.read_one().await);
    }
}

#[tokio::test]
async fn shells_get_the_upstream_agent_or_the_servers_own() {
    let upstream = SshAgentConfig {
        enabled: false,
        upstream_socket: Some("/tmp/upstream-agent.sock".into()),
    };
    assert_eq!(
        ssh_auth_sock_seen_with(upstream, None).await,
        "/tmp/upstream-agent.sock"
    );
    let on = SshAgentConfig {
        enabled: true,
        upstream_socket: None,
    };
    assert_eq!(
        ssh_auth_sock_seen_with(on.clone(), Some("/tmp/server-agent.sock")).await,
        "/tmp/server-agent.sock"
    );
    // The vault here is never unlocked. The shell still gets the server
    // agent's path, not the agent the server inherited, so it can sign once
    // the vault opens.
    let seen = ssh_auth_sock_seen_with(on, None).await;
    assert!(seen.ends_with("/ssh-agent.sock"), "{seen}");
}

async fn get(server: &Server, token: &str, path: &str) -> (u16, Value) {
    let response = app(server.state.clone())
        .oneshot(
            Request::get(path)
                .header("authorization", format!("Bearer {token}"))
                .header("host", "localhost:7878")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let status = response.status().as_u16();
    let bytes = response.into_body().collect().await.unwrap().to_bytes();
    (
        status,
        serde_json::from_slice(&bytes).unwrap_or(Value::Null),
    )
}

#[tokio::test]
async fn the_session_list_shows_what_a_terminal_device_can_attach_to() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let (_, reader) = device(&server.state, &[Scope::Read]).await;
    let (status, _) = get(&server, &reader, "/api/pty").await;
    assert_eq!(status, 403, "listing needs the scope attaching does");

    let mut client = Client::connect(&server, "ws:w1/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    let (status, body) = get(&server, &token, "/api/pty").await;
    assert_eq!(status, 200, "{body}");
    let sessions = body["sessions"].as_array().unwrap();
    assert_eq!(sessions.len(), 1, "{body}");
    let row = &sessions[0];
    assert_eq!(row["id"], "ws:w1/t1/p1");
    assert_eq!(row["kind"], "shell");
    assert_eq!(row["workspaceId"], "w1");
    assert_eq!(row["cwd"], server.dir.path().to_str().unwrap());
    assert_eq!(row["harness"], Value::Null);
    assert_eq!(row["running"], true);
    assert_eq!(row["exitCode"], Value::Null);
    assert_eq!(row["attached"], 1);
    assert!(row["startedAt"].as_i64().unwrap() > 0);

    let started = until("the pty.started event", || async {
        let events = server.state.events.since(0).await.unwrap();
        events.into_iter().find(|e| e.kind == "pty.started")
    })
    .await;
    assert_eq!(
        started.data,
        json!({ "id": "ws:w1/t1/p1", "kind": "shell", "workspaceId": "w1" })
    );

    client.input("exit 3\n").await;
    client.wait_for_close().await;
    let (_, body) = get(&server, &token, "/api/pty").await;
    let row = &body["sessions"][0];
    assert_eq!(row["running"], false, "{body}");
    assert_eq!(row["exitCode"], 3);
    assert_eq!(row["attached"], 0);
}

/// Prints `$var` in the shell `client` is attached to and returns its value.
async fn printed_var(client: &mut Client, var: &str) -> String {
    let label = format!("{}=[", var.to_lowercase());
    client
        .input(&format!("printf '{label}%s]\\n' \"${var}\"\n"))
        .await;
    // The echoed command line holds `%s`, so only the output follows the
    // label with anything else.
    loop {
        let out = String::from_utf8_lossy(&client.output).into_owned();
        let printed = out
            .split(label.as_str())
            .skip(1)
            .find(|rest| !rest.starts_with('%'));
        if let Some(rest) = printed
            && let Some(end) = rest.find(']')
        {
            return rest[..end].to_string();
        }
        assert!(client.read_one().await);
    }
}

/// A workspace shell gets the same scoped tokens the sidecar checks, so its
/// hooks can raise attention items and its MCP clients reach the sidecar.
#[tokio::test]
async fn workspace_shells_get_the_sidecars_scoped_tokens() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "ws:w1/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    assert_eq!(
        printed_var(&mut client, "YARVIS_ATTENTION_TOKEN").await,
        server.state.sidecar.attention_token()
    );
    assert_eq!(
        printed_var(&mut client, "YARVIS_MCP_TOKEN").await,
        server.state.sidecar.mcp_token()
    );
    assert_eq!(
        printed_var(&mut client, "YARVIS_SIDECAR_PORT").await,
        server.state.sidecar.endpoint().port.to_string()
    );
    // The bearer only signs; no shell sees it.
    assert_eq!(printed_var(&mut client, "YARVIS_SIDECAR_TOKEN").await, "");
}

/// `[server] path` is what a shell starts with, for a server under launchd
/// whose own `PATH` misses Homebrew and mise.
#[tokio::test]
async fn shells_start_with_the_configured_path() {
    let mut config = yarvis_server::config::Config::default();
    config.server.path = Some(" /opt/custom/bin:/usr/bin:/bin ".into());
    let state = yarvis_server::AppState::new(config, yarvis_server::store::testing::store().await);
    assert_eq!(
        state.pty.options().path.as_deref(),
        Some("/opt/custom/bin:/usr/bin:/bin")
    );

    let server = serve(PtyOptions {
        path: Some("/opt/custom/bin:/usr/bin:/bin".into()),
        ..PtyOptions::default()
    })
    .await;
    let (_, token) = device(&server.state, &[Scope::Terminal]).await;
    let mut client = Client::connect(&server, "tab:terminal/t1/p1", hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    assert_eq!(
        printed_var(&mut client, "PATH").await,
        "/opt/custom/bin:/usr/bin:/bin"
    );
}

/// A shell that only reads its terminal, from a script whose path shows in
/// `ps`, so a test can count the shells it started.
fn counted_shell(dir: &std::path::Path) -> String {
    use std::os::unix::fs::PermissionsExt;
    let script = dir.join("counted-shell");
    std::fs::write(&script, "#!/bin/sh\nwhile read -r line; do :; done\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();
    script.to_string_lossy().into_owned()
}

/// How many processes this test binary started are running `script`.
fn running(script: &str) -> usize {
    let out = std::process::Command::new("/bin/ps")
        .args(["-A", "-o", "ppid=,command="])
        .output()
        .unwrap();
    let me = std::process::id().to_string();
    String::from_utf8_lossy(&out.stdout)
        .lines()
        .filter(|line| {
            let mut fields = line.split_whitespace();
            fields.next() == Some(me.as_str()) && line.contains(script)
        })
        .count()
}

/// Two attaches racing for one id get the same session, and the shell the
/// losing spawn started is killed. The race can't be forced, so it runs for
/// several ids.
#[tokio::test]
async fn racing_spawns_for_one_id_leave_one_shell() {
    let dir = tempfile::tempdir().unwrap();
    let shell = counted_shell(dir.path());
    let server = serve(PtyOptions {
        shell: Some(shell.clone()),
        ..PtyOptions::default()
    })
    .await;
    const IDS: usize = 10;
    for n in 0..IDS {
        let id = format!("tab:terminal/race/{n}");
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(2));
        let attaches: Vec<_> = (0..2)
            .map(|_| {
                let (pty, barrier, id) = (server.state.pty.clone(), barrier.clone(), id.clone());
                tokio::task::spawn_blocking(move || {
                    barrier.wait();
                    pty.attach_or_spawn(
                        &id,
                        yarvis_server::pty::session::Size { cols: 80, rows: 24 },
                        None,
                    )
                })
            })
            .collect();
        let mut sessions = Vec::new();
        for attach in attaches {
            sessions.push(attach.await.unwrap().unwrap());
        }
        assert!(
            std::sync::Arc::ptr_eq(&sessions[0], &sessions[1]),
            "two sessions for {id}"
        );
    }
    assert_eq!(server.state.pty.list().len(), IDS);
    until("only the winning shells to be left", || {
        let left = running(&shell);
        async move { (left == IDS).then_some(()) }
    })
    .await;

    // Shutdown ends every shell, so none outlives the server.
    server.state.pty.kill_all();
    assert!(server.state.pty.list().is_empty());
    until("every shell to exit", || {
        let left = running(&shell);
        async move { (left == 0).then_some(()) }
    })
    .await;
}
