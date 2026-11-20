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

use common::{Server, WAIT, device, serve, until};

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
                self.texts.push(serde_json::from_str(&t).unwrap());
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
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    back.wait_for_output(&missed).await;
    assert!(
        !String::from_utf8_lossy(&back.output).contains("before-done"),
        "a resume replays only what came after the offset"
    );
}

#[tokio::test]
async fn an_offset_older_than_the_scrollback_gets_a_flagged_snapshot() {
    let server = serve(PtyOptions {
        scrollback_cap: 512,
        ..PtyOptions::default()
    })
    .await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    back.wait_for_output("all-done-2").await;
    assert!(back.output.len() <= 512);
}

#[tokio::test]
async fn two_clients_see_the_same_stream_and_either_can_type() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
}

#[tokio::test]
async fn focus_and_resize_move_the_size_to_that_client() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
async fn revoking_the_device_closes_its_terminal() {
    let server = serve(PtyOptions::default()).await;
    let (phone, token) = device(&server.state, &[Scope::Chat]).await;
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

#[tokio::test]
async fn a_malformed_hello_is_refused_without_spawning() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
    let mut client = Client::connect(&server, "review-claude:ws1", hello(&token, &server)).await;
    let error = client.wait_for_text("error").await;
    assert_eq!(error["error"], "the review session has ended");
    assert_eq!(client.wait_for_close().await, 4400);
}

#[tokio::test]
async fn an_exit_reaches_clients_after_the_last_byte_and_the_event_log() {
    let server = serve(PtyOptions::default()).await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
    let mut events = server.state.events.subscribe();
    let id = "tab:terminal/t1/p1";
    let mut client = Client::connect(&server, id, hello(&token, &server)).await;
    client.wait_for_text("attached").await;
    client.input("echo bye-$((40+2)); exit 3\n").await;
    let exit = client.wait_for_text("exit").await;
    assert_eq!(exit["code"], 3);
    assert!(String::from_utf8_lossy(&client.output).contains("bye-42"));
    assert_eq!(client.wait_for_close().await, 1000);

    let event = tokio::time::timeout(WAIT, events.recv())
        .await
        .expect("no event in time")
        .unwrap();
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
    let (_, chat) = device(&server.state, &[Scope::Read, Scope::Chat]).await;
    let (_, reader) = device(&server.state, &[Scope::Read]).await;
    let id = "tab:terminal/t1/p1";

    assert_eq!(
        core(&server, &reader, "pty_exists", json!({"id": id})).await,
        (200, json!(false))
    );
    let mut client = Client::connect(&server, id, hello(&chat, &server)).await;
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
            &chat,
            "pty_resize",
            json!({"id": id, "cols": 90, "rows": 25})
        )
        .await,
        (204, Value::Null)
    );
    let size = client.wait_for_text("size").await;
    assert_eq!(
        (size["cols"].clone(), size["rows"].clone()),
        (json!(90), json!(25))
    );

    let (status, body) = core(
        &server,
        &chat,
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
    let (status, config) = core(&server, &reader, "get_agent_config", json!({})).await;
    assert_eq!(status, 200);
    assert_eq!(config["defaultHarness"], "claude");
    assert_eq!(config["harnesses"][0]["id"], "claude");

    assert_eq!(
        core(&server, &chat, "pty_kill", json!({"id": id})).await,
        (204, Value::Null)
    );
    client.wait_for_text("exit").await;
    assert_eq!(
        core(&server, &reader, "pty_exists", json!({"id": id})).await,
        (200, json!(false))
    );
    let (status, _) = core(&server, &chat, "pty_attach", json!({"id": id})).await;
    assert_eq!(status, 404);
}

#[tokio::test]
async fn a_client_that_stops_reading_is_resynced_without_holding_up_the_other() {
    let server = serve(PtyOptions {
        client_queue: 2,
        ..PtyOptions::default()
    })
    .await;
    let (_, token) = device(&server.state, &[Scope::Chat]).await;
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
    let resync = slow
        .texts
        .iter()
        .find(|t| t["type"] == "resync")
        .expect("the slow client was resynced");
    assert!(resync["requestedOffset"].as_u64().is_some());
}
