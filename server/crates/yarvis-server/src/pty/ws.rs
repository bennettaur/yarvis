//! `GET /api/pty/{id}`: one client attached to one PTY session.
//!
//! The protocol, written out in `docs/client-server.md`:
//! - The client's first message is the auth hello, which also carries the
//!   viewport, an optional `offset` to resume from and an optional `cwd` for a
//!   shell spawned by this attach.
//! - The server answers with an `attached` JSON message and one binary
//!   catch-up frame, then streams binary output frames: an 8-byte big-endian
//!   stream offset, then the bytes. Each frame starts where the previous one
//!   ended. `size` messages report the PTY size and which client owns it.
//!   A client that falls behind is resynced (`resync`, then a catch-up frame)
//!   from its last offset. `exit` follows the last output byte.
//! - The client sends input as binary frames or `{"type":"input","data"}`, its
//!   viewport as `{"type":"resize","cols","rows"}`, and `{"type":"focus"}` to
//!   take over the PTY size.

use std::sync::Arc;
use std::sync::atomic::Ordering;

use axum::extract::ws::{CloseFrame, Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::response::Response;
use futures_util::stream::{SplitSink, SplitStream};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{Map, Value, json};
use tokio::sync::broadcast;

use super::MAX_WRITE_BYTES;
use super::session::{Attach, Event, Session, Size};
use crate::AppState;
use crate::auth::{CloseReason, Scope, authenticate_ws, close};

/// Input is the largest thing a client sends: a write's worth of bytes,
/// which JSON escaping can grow.
const MAX_CLIENT_MESSAGE: usize = 2 * MAX_WRITE_BYTES + 1024;

/// Longest session id accepted. Ids are client-chosen keys such as
/// `ws:<workspaceId>/<tab>/<pane>`, and one reaches every PTY's environment.
const MAX_ID_CHARS: usize = 256;

/// What the hello carries besides the token.
struct Hello {
    offset: Option<u64>,
    size: Size,
    cwd: Option<String>,
}

fn parse_hello(extra: &Map<String, Value>) -> Option<Hello> {
    let dimension = |key: &str| match extra.get(key) {
        None => Some(None),
        Some(v) => v
            .as_u64()
            .and_then(|n| u16::try_from(n).ok())
            .filter(|n| *n > 0)
            .map(Some),
    };
    let offset = match extra.get("offset") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_u64()?),
    };
    let cwd = match extra.get("cwd") {
        None | Some(Value::Null) => None,
        Some(v) => Some(v.as_str()?.to_string()),
    };
    Some(Hello {
        offset,
        size: Size {
            cols: dimension("cols")?.unwrap_or(80),
            rows: dimension("rows")?.unwrap_or(24),
        },
        cwd,
    })
}

fn is_valid_id(id: &str) -> bool {
    !id.is_empty() && id.chars().count() <= MAX_ID_CHARS && !id.chars().any(char::is_control)
}

pub async fn ws(
    ws: WebSocketUpgrade,
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> Response {
    ws.max_message_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| serve(socket, state, id))
}

async fn serve(mut socket: WebSocket, state: AppState, id: String) {
    // Subscribe before authenticating, so a revocation that lands while the
    // token is being checked still reaches this socket.
    let revoked = state.auth.subscribe_revocations();
    let Some((device, hello)) = authenticate_ws(&mut socket, &state.auth, Scope::Terminal).await
    else {
        return;
    };
    let Some(hello) = parse_hello(&hello.extra).filter(|_| is_valid_id(&id)) else {
        close(&mut socket, CloseReason::BadRequest).await;
        return;
    };
    let pty = state.pty.clone();
    let size = hello.size;
    let cwd = hello.cwd;
    let attached = tokio::task::spawn_blocking(move || pty.attach_or_spawn(&id, size, cwd)).await;
    let session = match attached {
        Ok(Ok(session)) => session,
        Ok(Err(e)) => {
            // The client can't fix a refusal by retrying (the cap, an ended
            // review session), so it gets the reason and a 4400, which
            // clients don't reconnect on (`docs/client-server.md`).
            let _ = socket
                .send(Message::Text(
                    json!({ "type": "error", "error": e }).to_string().into(),
                ))
                .await;
            close(&mut socket, CloseReason::BadRequest).await;
            return;
        }
        Err(e) => {
            tracing::error!("PTY attach failed: {e}");
            close(&mut socket, CloseReason::Internal).await;
            return;
        }
    };
    let client = state.pty.next_client_id();
    let send_timeout = state.pty.options().send_timeout;
    session.set_client_size(client, hello.size);
    client_loop(
        socket,
        session.clone(),
        client,
        hello.offset,
        Revocation {
            rx: revoked,
            device_id: device.device_id,
        },
        send_timeout,
    )
    .await;
    session.detach(client);
}

struct Revocation {
    rx: broadcast::Receiver<String>,
    device_id: String,
}

#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum ClientMsg {
    Input { data: String },
    Resize { cols: u16, rows: u16 },
    Focus,
}

/// Why the client's side of the socket ended.
enum InputEnd {
    Closed,
    Revoked,
    /// A write over [`MAX_WRITE_BYTES`].
    TooLarge,
}

/// True when `data` is only replies a terminal sends on its own: answers to
/// cursor-position, device-attribute, mode, window and colour queries, string
/// reports (DCS, OSC, APC), and focus-out. Anything else, a lone `ESC`
/// included, counts as the user's input. A key whose encoding matches a reply
/// (F3 with a modifier is `CSI 1;2R`, like a cursor report) is read as a reply,
/// which costs only that keypress not taking over the size.
fn is_terminal_reply(data: &[u8]) -> bool {
    const ESC: u8 = 0x1b;
    if data.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < data.len() {
        if data[i] != ESC || i + 1 >= data.len() {
            return false;
        }
        match data[i + 1] {
            b'[' => {
                let params_start = i + 2;
                let mut j = params_start;
                while j < data.len() && (0x30..=0x3f).contains(&data[j]) {
                    j += 1;
                }
                let params = &data[params_start..j];
                let intermediates_start = j;
                while j < data.len() && (0x20..=0x2f).contains(&data[j]) {
                    j += 1;
                }
                let intermediates = &data[intermediates_start..j];
                let Some(&last) = data.get(j) else {
                    return false;
                };
                let reply = match last {
                    // Cursor position, device attributes, device status, window reports.
                    b'R' | b'c' | b'n' | b't' => intermediates.is_empty(),
                    // DECRQM's mode report.
                    b'y' => intermediates == b"$",
                    // The kitty keyboard protocol's flags report; `CSI … u` without
                    // the `?` is a key.
                    b'u' => params.first() == Some(&b'?'),
                    // Focus out. Focus in is left as input: it means the user
                    // came to this terminal, as `{"type":"focus"}` does.
                    b'O' => params.is_empty() && intermediates.is_empty(),
                    _ => false,
                };
                if !reply {
                    return false;
                }
                i = j + 1;
            }
            // OSC (colour replies) ends at BEL or ST; DCS and APC end at ST.
            kind @ (b']' | b'P' | b'_') => {
                let mut j = i + 2;
                let end = loop {
                    match data.get(j) {
                        None => return false,
                        Some(0x07) if kind == b']' => break j + 1,
                        Some(&ESC) if data.get(j + 1) == Some(&b'\\') => break j + 2,
                        _ => j += 1,
                    }
                };
                i = end;
            }
            _ => return false,
        }
    }
    true
}

fn output_frame(offset: u64, bytes: &[u8]) -> Message {
    let mut v = Vec::with_capacity(8 + bytes.len());
    v.extend_from_slice(&offset.to_be_bytes());
    v.extend_from_slice(bytes);
    Message::Binary(v.into())
}

fn attached_msg(kind: &str, client: u64, a: &Attach, requested: Option<u64>) -> Message {
    let v = json!({
        "type": kind,
        "clientId": client,
        "mode": if a.resumed { "resume" } else { "snapshot" },
        "requestedOffset": requested,
        "startOffset": a.start_offset,
        "endOffset": a.start_offset + a.catchup.len() as u64,
        "lostBytes": a.lost_bytes,
        "cols": a.size.cols,
        "rows": a.size.rows,
        "owner": a.owner,
        "exit": a.exit,
    });
    Message::Text(v.to_string().into())
}

fn text(v: Value) -> Message {
    Message::Text(v.to_string().into())
}

fn close_frame(reason: CloseReason) -> Message {
    Message::Close(Some(CloseFrame {
        code: reason.code(),
        reason: match reason {
            CloseReason::Unauthorized => "sign in first",
            CloseReason::BadRequest => "bad request",
            CloseReason::Forbidden => "missing scope",
            CloseReason::Internal => "internal error",
        }
        .into(),
    }))
}

/// Sends `message`, or reports `false` when the socket failed or the send
/// blocked past `send_timeout`, which drops a client the network has stalled.
async fn send_within(
    sink: &mut SplitSink<WebSocket, Message>,
    send_timeout: std::time::Duration,
    message: Message,
) -> bool {
    matches!(
        tokio::time::timeout(send_timeout, sink.send(message)).await,
        Ok(Ok(()))
    )
}

/// Forwards the client's input, viewport and focus to the session until the
/// client closes, sends too much, or its device is revoked. It watches the
/// revocation itself so a revoked device's keys stop at once, even while the
/// output side is stuck sending.
async fn read_client_input(
    mut stream: SplitStream<WebSocket>,
    session: Arc<Session>,
    client: u64,
    mut revocation: Revocation,
) -> InputEnd {
    loop {
        let msg = tokio::select! {
            msg = stream.next() => match msg {
                Some(Ok(msg)) => msg,
                _ => return InputEnd::Closed,
            },
            id = revocation.rx.recv() => match id {
                Ok(id) if id != revocation.device_id => continue,
                // Revoked, or revocations were missed and this device might
                // be among them: stop either way.
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => return InputEnd::Revoked,
                Err(broadcast::error::RecvError::Closed) => return InputEnd::Closed,
            },
        };
        let data = match msg {
            Message::Binary(b) => b.to_vec(),
            Message::Text(t) => match serde_json::from_str::<ClientMsg>(&t) {
                Ok(ClientMsg::Input { data }) => data.into_bytes(),
                Ok(ClientMsg::Resize { cols, rows }) => {
                    // A zero-sized viewport is a hidden terminal, not a size.
                    if cols > 0 && rows > 0 {
                        session.set_client_size(client, Size { cols, rows });
                    }
                    continue;
                }
                Ok(ClientMsg::Focus) => {
                    session.claim(client);
                    continue;
                }
                Err(_) => continue,
            },
            Message::Close(_) => return InputEnd::Closed,
            _ => continue,
        };
        if data.len() > MAX_WRITE_BYTES {
            return InputEnd::TooLarge;
        }
        // Every attached terminal answers the program's queries, not just the
        // one the user is at. If those answers took over the size, two clients
        // with different viewports would resize the PTY back and forth each
        // time the program asks, and a program that asks again after a resize
        // would flicker for as long as both stay attached.
        let typist = (!is_terminal_reply(&data)).then_some(client);
        // An error means the shell is gone; the output side delivers `exit`.
        let _ = session.write(typist, data).await;
    }
}

async fn client_loop(
    socket: WebSocket,
    session: Arc<Session>,
    client: u64,
    from: Option<u64>,
    revocation: Revocation,
    send_timeout: std::time::Duration,
) {
    let (mut sink, stream) = socket.split();
    // Input runs on its own task so a client whose outbound socket is backed
    // up can still type.
    let mut input_task = tokio::spawn(read_client_input(
        stream,
        session.clone(),
        client,
        revocation,
    ));

    let mut kind = "attached";
    let mut requested = from;
    let ending: Option<Message> = 'outer: loop {
        let mut attach = session.subscribe(client, requested);
        let mut next = attach.start_offset + attach.catchup.len() as u64;
        for message in [
            attached_msg(kind, client, &attach, requested),
            output_frame(attach.start_offset, &attach.catchup),
        ] {
            if !send_within(&mut sink, send_timeout, message).await {
                break 'outer None;
            }
        }
        loop {
            let message = tokio::select! {
                event = attach.rx.recv() => match event {
                    Some(Event::Output { offset, bytes }) => {
                        debug_assert_eq!(offset, next, "stream must be contiguous");
                        next = offset + bytes.len() as u64;
                        output_frame(offset, &bytes)
                    }
                    Some(Event::Size { size, owner }) => text(
                        json!({"type": "size", "cols": size.cols, "rows": size.rows, "owner": owner}),
                    ),
                    None if attach.lagged.load(Ordering::SeqCst) => {
                        // Dropped for falling behind: resume from the last
                        // byte this client was sent, or a fresh snapshot if
                        // that has left scrollback.
                        kind = "resync";
                        requested = Some(next);
                        continue 'outer;
                    }
                    None => {
                        let exit = text(json!({"type": "exit", "code": session.exit_code()}));
                        let _ = send_within(&mut sink, send_timeout, exit).await;
                        break 'outer Some(Message::Close(Some(CloseFrame {
                            code: axum::extract::ws::close_code::NORMAL,
                            reason: "the session ended".into(),
                        })));
                    }
                },
                end = &mut input_task => match end {
                    Ok(InputEnd::Revoked) => break 'outer Some(close_frame(CloseReason::Unauthorized)),
                    Ok(InputEnd::TooLarge) => break 'outer Some(close_frame(CloseReason::BadRequest)),
                    _ => break 'outer None,
                },
            };
            if !send_within(&mut sink, send_timeout, message).await {
                break 'outer None;
            }
        }
    };
    input_task.abort();
    if let Some(message) = ending {
        let _ = send_within(&mut sink, send_timeout, message).await;
    }
    let _ = sink.close().await;
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hello(v: Value) -> Option<Hello> {
        parse_hello(v.as_object().unwrap())
    }

    #[test]
    fn reads_the_hello_the_web_client_sends() {
        let h = hello(json!({"offset": 42, "cols": 120, "rows": 40, "cwd": "/w"})).unwrap();
        assert_eq!(h.offset, Some(42));
        assert_eq!(
            h.size,
            Size {
                cols: 120,
                rows: 40
            }
        );
        assert_eq!(h.cwd.as_deref(), Some("/w"));
        let bare = hello(json!({})).unwrap();
        assert_eq!(bare.offset, None);
        assert_eq!(bare.size, Size { cols: 80, rows: 24 });
    }

    #[test]
    fn refuses_a_malformed_hello() {
        for bad in [
            json!({"offset": -1}),
            json!({"offset": "12"}),
            json!({"cols": 0}),
            json!({"rows": 70000}),
            json!({"cwd": 5}),
        ] {
            assert!(hello(bad.clone()).is_none(), "{bad}");
        }
    }

    #[test]
    fn tells_terminal_replies_from_typing() {
        for reply in [
            &b"\x1b[12;40R"[..],
            b"\x1b[?1;2c",
            b"\x1b[>0;276;0c",
            b"\x1b[0n",
            b"\x1b[?2026;2$y",
            b"\x1b[8;30;100t",
            b"\x1b[?1u",
            b"\x1b[O",
            b"\x1b]11;rgb:0000/0000/0000\x07",
            b"\x1b]10;rgb:ffff/ffff/ffff\x1b\\",
            b"\x1bP>|xterm.js(5.5.0)\x1b\\",
            // Several replies in one write, as xterm.js sends after a burst of queries.
            b"\x1b[?1;2c\x1b]11;rgb:1e1e/1e1e/1e1e\x1b\\\x1b[3;1R",
        ] {
            assert!(is_terminal_reply(reply), "{reply:?}");
        }
        for typed in [
            &b""[..],
            b"a",
            b"\r",
            b"\x1b",
            b"\x1b[A",
            b"\x1b[13;2u",
            b"\x1b[I",
            b"\x1b[<0;10;5M",
            b"\x1b[200~pasted\x1b[201~",
            // A reply with a keystroke after it is still typing.
            b"\x1b[?1;2cx",
            b"\x1b]11;rgb:0000/0000/0000",
            b"\x1b[12;40",
        ] {
            assert!(!is_terminal_reply(typed), "{typed:?}");
        }
    }

    #[test]
    fn refuses_an_id_no_client_would_use() {
        assert!(is_valid_id("ws:abc/t1/p1"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("a\nb"));
        assert!(!is_valid_id(&"a".repeat(MAX_ID_CHARS + 1)));
    }
}
