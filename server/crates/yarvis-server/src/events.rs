//! The append-only event log, and the `/api/events` WebSocket that streams it.
//!
//! Every event records the device whose request caused it (`None` for the
//! server's own work, such as a sidecar restart). A client that reconnects
//! sends the last `seq` it saw and gets everything after it, so a phone that
//! slept through an approval request still sees it.

use std::sync::Arc;

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

/// Taken by every append for the rest of its transaction.
const APPEND_LOCK: &str = "SELECT pg_advisory_xact_lock(hashtext($1))";

/// Per schema, so two servers on separate schemas don't wait on each other.
fn append_lock_name(schema: &str) -> String {
    format!("{schema}.events")
}

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
    /// Held from the insert to the broadcast, so this process sends events
    /// in `seq` order.
    order: Arc<tokio::sync::Mutex<()>>,
}

impl EventLog {
    pub fn new(store: Store) -> Self {
        let (tx, _) = broadcast::channel(LIVE_BUFFER);
        Self {
            store,
            tx,
            order: Arc::default(),
        }
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
        // A client that reconnects with the highest `seq` it saw would skip
        // one that became visible late, so events must commit and be sent in
        // `seq` order. Postgres hands out identity values before commit, so
        // the advisory lock makes appends from every process take turns, and
        // `order` keeps this process's broadcasts in the same order.
        let _order = self.order.lock().await;
        let mut tx = self.store.begin().await?;
        sqlx::query(APPEND_LOCK)
            .bind(append_lock_name(self.store.schema()))
            .execute(&mut *tx)
            .await?;
        let at = now_ms();
        let seq: i64 = sqlx::query_scalar(
            "INSERT INTO events (at, device_id, kind, data) VALUES ($1, $2, $3, $4) RETURNING seq",
        )
        .bind(at)
        .bind(device_id)
        .bind(kind)
        .bind(data.to_string())
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
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
        let rows: Vec<(i64, i64, Option<String>, String, String)> = sqlx::query_as(
            "SELECT seq, at, device_id, kind, data FROM events
             WHERE seq > $1 ORDER BY seq LIMIT $2",
        )
        .bind(seq)
        .bind(MAX_CATCH_UP)
        .fetch_all(self.store.db()?)
        .await?;
        Ok(rows
            .into_iter()
            .map(|(seq, at, device_id, kind, data)| {
                // Only `append` writes this column, from a `Value`, so a
                // parse failure means a corrupt row. Send null rather than
                // stop every client's catch-up on it.
                let data = serde_json::from_str(&data).unwrap_or_else(|e| {
                    tracing::error!("event {seq} has unreadable data: {e}");
                    serde_json::Value::Null
                });
                Event {
                    seq,
                    at,
                    device_id,
                    kind,
                    data,
                }
            })
            .collect())
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
        let log = EventLog::new(crate::store::testing::store().await);
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

    /// Another process midway through an append (lock taken, row inserted, not
    /// yet committed) holds up this one, so the higher `seq` can't become
    /// visible before the lower one.
    #[tokio::test]
    async fn an_append_waits_for_an_earlier_one_still_in_flight() {
        use crate::store::testing;
        let schema = testing::new_schema().await;
        let url = testing::test_database_url();
        let other = Store::connect(&url, &schema).await.unwrap();
        let log = EventLog::new(Store::connect(&url, &schema).await.unwrap());
        let mut in_flight = other.begin().await.unwrap();
        sqlx::query(APPEND_LOCK)
            .bind(append_lock_name(&schema))
            .execute(&mut *in_flight)
            .await
            .unwrap();
        let first: i64 = sqlx::query_scalar(
            "INSERT INTO events (at, kind, data) VALUES (0, 'first', '{}') RETURNING seq",
        )
        .fetch_one(&mut *in_flight)
        .await
        .unwrap();
        let second = tokio::spawn(async move {
            log.append(None, "second", serde_json::json!({}))
                .await
                .unwrap()
                .seq
        });
        tokio::time::sleep(std::time::Duration::from_millis(200)).await;
        assert!(!second.is_finished(), "committed ahead of a lower seq");
        in_flight.commit().await.unwrap();
        assert!(second.await.unwrap() > first);
    }

    /// Several processes appending at once, with a client catching up all the
    /// while: if a lower `seq` could commit after a higher one, the reader
    /// would move past it and never see it.
    #[tokio::test]
    async fn catch_up_misses_nothing_while_several_processes_append() {
        use crate::store::testing;
        const WRITERS: usize = 6;
        const EACH: usize = 60;
        let schema = testing::new_schema().await;
        let url = testing::test_database_url();
        let reader = EventLog::new(Store::connect(&url, &schema).await.unwrap());
        let mut writers = Vec::new();
        for _ in 0..WRITERS {
            let log = EventLog::new(Store::connect(&url, &schema).await.unwrap());
            writers.push(tokio::spawn(async move {
                for _ in 0..EACH {
                    log.append(None, "x", serde_json::json!({})).await.unwrap();
                }
            }));
        }
        let mut seen = Vec::new();
        let mut last = 0;
        loop {
            // Checked before the read, so the read after the last append
            // still happens.
            let done = writers.iter().all(|w| w.is_finished());
            let batch = reader.since(last).await.unwrap();
            if done && batch.is_empty() {
                break;
            }
            for event in batch {
                last = event.seq;
                seen.push(event.seq);
            }
            tokio::task::yield_now().await;
        }
        for writer in writers {
            writer.await.unwrap();
        }
        let all: Vec<i64> = reader
            .since(0)
            .await
            .unwrap()
            .iter()
            .map(|e| e.seq)
            .collect();
        assert_eq!(all.len(), WRITERS * EACH);
        assert_eq!(seen, all, "the reader skipped an event that committed late");
    }
}
