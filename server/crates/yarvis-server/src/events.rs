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
use crate::auth::{Scope, authenticate_ws};
use crate::store::{Store, StoreError, now_ms};

/// How many events a reconnecting client can catch up on in one go. Past
/// this it should reload whatever it shows rather than replay history.
const MAX_CATCH_UP: i64 = 1000;

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
        let (tx, _) = broadcast::channel(256);
        Self { store, tx }
    }

    /// Stores an event and sends it to every connected client.
    pub async fn append(
        &self,
        device_id: Option<&str>,
        kind: &str,
        data: serde_json::Value,
    ) -> Result<Event, StoreError> {
        let (device, kind_owned, text) = (
            device_id.map(str::to_string),
            kind.to_string(),
            data.to_string(),
        );
        let at = now_ms();
        let seq = self
            .store
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO events (at, device_id, kind, data) VALUES (?1, ?2, ?3, ?4)",
                    rusqlite::params![at, device, kind_owned, text],
                )?;
                Ok(conn.last_insert_rowid())
            })
            .await?;
        let event = Event {
            seq,
            at,
            device_id: device_id.map(str::to_string),
            kind: kind.to_string(),
            data,
        };
        let _ = self.tx.send(event.clone());
        Ok(event)
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
                    let data: String = row.get(4)?;
                    Ok(Event {
                        seq: row.get(0)?,
                        at: row.get(1)?,
                        device_id: row.get(2)?,
                        kind: row.get(3)?,
                        data: serde_json::from_str(&data).unwrap_or(serde_json::Value::Null),
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
    /// The client fell too far behind and missed events. It should reload.
    Lagged,
}

pub async fn ws(ws: WebSocketUpgrade, State(state): State<AppState>) -> Response {
    ws.on_upgrade(move |socket| stream(socket, state))
}

async fn stream(mut socket: WebSocket, state: AppState) {
    let Some((device, hello)) = authenticate_ws(&mut socket, &state.auth, Scope::Read).await else {
        return;
    };
    // Subscribe before reading the backlog so nothing lands in the gap.
    let mut live = state.events.subscribe();
    let mut revoked = state.auth.subscribe_revocations();
    let mut last_seq = 0;
    if let Some(since) = hello.extra.get("since").and_then(|v| v.as_i64()) {
        match state.events.since(since).await {
            Ok(backlog) => {
                for event in &backlog {
                    if send(&mut socket, &Outgoing::Event(event)).await.is_err() {
                        return;
                    }
                    last_seq = event.seq;
                }
            }
            Err(e) => {
                tracing::error!("event catch-up failed: {e}");
                return;
            }
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
            id = revoked.recv() => {
                if matches!(id, Ok(id) if id == device.device_id) {
                    let _ = socket.send(Message::Close(None)).await;
                    return;
                }
            }
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
