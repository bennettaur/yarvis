//! The append-only event log, and the `/api/events` WebSocket that streams it.
//!
//! Every event records the device whose request caused it (`None` for the
//! server's own work, such as a sidecar restart). A client that reconnects
//! sends the last `seq` it saw and gets everything after it, so a phone that
//! slept through an approval request still sees it.

use axum::extract::State;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::response::Response;
use serde::Serialize;
use tokio::sync::broadcast;

use crate::AppState;
use crate::auth::{CloseReason, Scope, authenticate_ws, close};
use crate::store::{Store, StoreError, now_ms};

/// How many events a reconnecting client can catch up on. A client further
/// behind than this gets `lagged` and should reload what it shows instead of
/// replaying history.
const MAX_CATCH_UP: i64 = 1000;

/// How many events can wait for a slow client before it gets `lagged`.
const LIVE_BUFFER: usize = 256;

/// The auth message and pings are all a client sends on this socket.
const MAX_CLIENT_MESSAGE: usize = 16 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Event {
    pub seq: i64,
    pub at: i64,
    pub device_id: Option<String>,
    pub kind: String,
    pub data: serde_json::Value,
}

#[derive(Clone)]
pub struct EventLog {
    store: Store,
    tx: broadcast::Sender<Event>,
}

impl EventLog {
    pub fn new(store: Store) -> Self {
        let (tx, _) = broadcast::channel(LIVE_BUFFER);
        Self { store, tx }
    }

    /// Stores an event and sends it to every connected client. Any device
    /// with `read` can see every event, past ones included, so `data` must
    /// never hold a token or a secret value.
    pub async fn append(
        &self,
        device_id: Option<&str>,
        kind: &str,
        data: serde_json::Value,
    ) -> Result<Event, StoreError> {
        let tx = self.tx.clone();
        let (device_id, kind) = (device_id.map(str::to_string), kind.to_string());
        // The broadcast happens inside the store call, under its lock, so
        // clients receive events in `seq` order. A client that reconnects with
        // the highest `seq` it saw would otherwise skip one that arrived late.
        self.store
            .call(move |conn| {
                let at = now_ms();
                conn.execute(
                    "INSERT INTO events (at, device_id, kind, data) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![at, device_id, kind, data.to_string()],
                )?;
                let event = Event {
                    seq: conn.last_insert_rowid(),
                    at,
                    device_id,
                    kind,
                    data,
                };
                let _ = tx.send(event.clone());
                Ok(event)
            })
            .await
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Event> {
        self.tx.subscribe()
    }

    /// Events after `seq`, oldest first.
    pub async fn since(&self, seq: i64) -> Result<Vec<Event>, StoreError> {
        self.store
            .call(move |conn| {
                let mut stmt = conn.prepare(
                    "SELECT seq, at, device_id, kind, data FROM events
                     WHERE seq > ?1 ORDER BY seq LIMIT ?2",
                )?;
                let rows = stmt.query_map(rusqlite::params![seq, MAX_CATCH_UP], |row| {
                    let seq = row.get(0)?;
                    let data: String = row.get(4)?;
                    // Only `append` writes this column, from a `Value`, so a
                    // parse failure means a corrupt row. Send null rather than
                    // stop every client's catch-up on it.
                    let data = serde_json::from_str(&data).unwrap_or_else(|e| {
                        tracing::error!("event {seq} has unreadable data: {e}");
                        serde_json::Value::Null
                    });
                    Ok(Event {
                        seq,
                        at: row.get(1)?,
                        device_id: row.get(2)?,
                        kind: row.get(3)?,
                        data,
                    })
                })?;
                rows.collect()
            })
            .await
    }
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
enum Outgoing<'a> {
    Event(&'a Event),
    /// The client fell too far behind and missed events. It should reload,
    /// then reconnect without `since`. The server closes the socket after this.
    Lagged,
}

pub async fn ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.max_message_size(MAX_CLIENT_MESSAGE)
        .on_upgrade(move |socket| stream(socket, state))
}

async fn stream(mut socket: WebSocket, state: AppState) {
    // Subscribe before authenticating, so a revocation that lands while the
    // token is being checked still reaches this socket.
    let mut revoked = state.auth.subscribe_revocations();
    let Some((device, hello)) = authenticate_ws(&mut socket, &state.auth, Scope::Read).await else {
        return;
    };
    let since = match hello.extra.get("since") {
        None => None,
        Some(value) => match value.as_i64() {
            Some(seq) if seq >= 0 => Some(seq),
            _ => {
                close(&mut socket, CloseReason::BadRequest).await;
                return;
            }
        },
    };
    // Subscribe before reading the backlog so nothing lands in the gap.
    let mut live = state.events.subscribe();
    // The highest seq already sent, so the live stream skips events the
    // backlog covered.
    let mut last_seq = 0;
    if let Some(since) = since {
        let backlog = match state.events.since(since).await {
            Ok(backlog) => backlog,
            Err(e) => {
                tracing::error!("event catch-up failed: {e}");
                close(&mut socket, CloseReason::Internal).await;
                return;
            }
        };
        if backlog.len() as i64 >= MAX_CATCH_UP {
            let _ = send(&mut socket, &Outgoing::Lagged).await;
            return;
        }
        for event in &backlog {
            if send(&mut socket, &Outgoing::Event(event)).await.is_err() {
                return;
            }
            last_seq = event.seq;
        }
    }
    loop {
        tokio::select! {
            event = live.recv() => match event {
                Ok(event) if event.seq > last_seq => {
                    if send(&mut socket, &Outgoing::Event(&event)).await.is_err() {
                        return;
                    }
                }
                Ok(_) => {}
                Err(broadcast::error::RecvError::Lagged(_)) => {
                    let _ = send(&mut socket, &Outgoing::Lagged).await;
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            id = revoked.recv() => match id {
                Ok(id) if id != device.device_id => {}
                // Revoked, or revocations were missed and this device might be
                // among them: close either way, and let the client re-auth.
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {
                    close(&mut socket, CloseReason::Unauthorized).await;
                    return;
                }
                Err(broadcast::error::RecvError::Closed) => return,
            },
            incoming = socket.recv() => match incoming {
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return,
                Some(Ok(_)) => {}
            },
        }
    }
}

async fn send(socket: &mut WebSocket, message: &Outgoing<'_>) -> Result<(), axum::Error> {
    let text = serde_json::to_string(message).expect("events serialize");
    socket.send(Message::Text(text.into())).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn catch_up_returns_only_later_events_in_order() {
        let log = EventLog::new(Store::open_in_memory().unwrap());
        let first = log
            .append(Some("d1"), "a", serde_json::json!({}))
            .await
            .unwrap();
        log.append(None, "b", serde_json::json!({"x": 1}))
            .await
            .unwrap();
        log.append(Some("d2"), "c", serde_json::json!({}))
            .await
            .unwrap();
        let later = log.since(first.seq).await.unwrap();
        let kinds: Vec<_> = later.iter().map(|e| e.kind.as_str()).collect();
        assert_eq!(kinds, ["b", "c"]);
        assert_eq!(later[0].device_id, None);
        assert_eq!(later[0].data["x"], 1);
    }
}
