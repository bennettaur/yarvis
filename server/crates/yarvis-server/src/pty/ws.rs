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
    let Some((device, hello)) = authenticate_ws(&mut socket, &state.auth, Scope::Chat).await else {
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
        // An error means the shell is gone; the output side delivers `exit`.
        let _ = session.write(Some(client), data).await;
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
    fn refuses_an_id_no_client_would_use() {
        assert!(is_valid_id("ws:abc/t1/p1"));
        assert!(!is_valid_id(""));
        assert!(!is_valid_id("a\nb"));
        assert!(!is_valid_id(&"a".repeat(MAX_ID_CHARS + 1)));
    }
}
