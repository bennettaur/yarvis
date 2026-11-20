//! Approvals: server code asks a question, any device with the `approve`
//! scope answers, and the first answer wins.
//!
//! [`Approvals::request`] is the entry point for other modules (the ssh-agent
//! signing gate, tool calls). It stores the approval, announces it on the
//! event log, and waits. No answer before the timeout is a denial, and so is
//! an approval left pending by a restart or by a requester that stopped
//! waiting: nothing is left to act on a late "yes".
//!
//! First-wins is one conditional `UPDATE ... WHERE status = 'pending'`. The
//! store has one connection, so two devices answering at once are ordered and
//! the second updates nothing.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tokio::sync::oneshot;

use crate::AppState;
use crate::auth::{Approve, Authed, Read, new_id};
use crate::error::{ApiError, ApiResult};
use crate::events::EventLog;
use crate::store::{Store, StoreError, now_ms};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Decision {
    Approved {
        by: String,
    },
    Denied {
        by: String,
    },
    /// Nobody answered in time, or the approval was abandoned. Treat as a no.
    TimedOut,
}

impl Decision {
    pub fn approved(&self) -> bool {
        matches!(self, Decision::Approved { .. })
    }
}

/// A pending approval as clients see it.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Pending {
    pub id: String,
    pub kind: String,
    pub summary: String,
    pub data: Value,
    pub created_at: i64,
    pub expires_at: i64,
}

pub enum Answer {
    Answered(Decision),
    /// Someone answered first, or it timed out. Carries what it ended as.
    AlreadySettled(Decision),
    NotFound,
}

type Waiters = Arc<Mutex<HashMap<String, oneshot::Sender<Decision>>>>;

#[derive(Clone)]
pub struct Approvals {
    store: Store,
    events: EventLog,
    waiters: Waiters,
}

impl Approvals {
    pub fn new(store: Store, events: EventLog) -> Self {
        Self {
            store,
            events,
            waiters: Arc::default(),
        }
    }

    /// Asks every device with the `approve` scope and waits for the first
    /// answer, or `timeout`. `summary` is the one line a device shows; `data`
    /// is whatever detail the kind defines (the signing gate's key and
    /// repo, say).
    pub async fn request(
        &self,
        kind: &str,
        summary: &str,
        data: Value,
        timeout: Duration,
    ) -> Result<Decision, StoreError> {
        let created_at = now_ms();
        let pending = Pending {
            id: new_id(),
            kind: kind.to_string(),
            summary: summary.to_string(),
            data,
            created_at,
            expires_at: created_at + timeout.as_millis() as i64,
        };
        let row = pending.clone();
        self.store
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO approvals (id, kind, summary, data, created_at, expires_at, status)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending')",
                    rusqlite::params![
                        row.id,
                        row.kind,
                        row.summary,
                        row.data.to_string(),
                        row.created_at,
                        row.expires_at
                    ],
                )
            })
            .await?;

        // Registered before the event goes out, so an answer can't land
        // before anyone is listening for it.
        let (tx, rx) = oneshot::channel();
        lock(&self.waiters).insert(pending.id.clone(), tx);
        let mut guard = AbandonGuard {
            approvals: self.clone(),
            id: Some(pending.id.clone()),
        };
        self.events
            .append(
                None,
                "approval.requested",
                serde_json::to_value(&pending).expect("serializes"),
            )
            .await?;

        let decision = match tokio::time::timeout(timeout, rx).await {
            Ok(Ok(decision)) => decision,
            _ => self.settle_unanswered(&pending.id, "timeout").await?,
        };
        guard.id = None;
        lock(&self.waiters).remove(&pending.id);
        Ok(decision)
    }

    /// Records a device's answer. Only the first one counts.
    pub async fn answer(
        &self,
        id: &str,
        device_id: &str,
        approve: bool,
    ) -> Result<Answer, StoreError> {
        let (row_id, by, now) = (id.to_string(), device_id.to_string(), now_ms());
        let status = if approve { "approved" } else { "denied" };
        let won = self
            .store
            .call(move |conn| {
                conn.execute(
                    "UPDATE approvals
                     SET status = ?1, outcome = 'answered', answered_by = ?2, answered_at = ?3
                     WHERE id = ?4 AND status = 'pending' AND expires_at > ?3",
                    rusqlite::params![status, by, now, row_id],
                )
            })
            .await?
            == 1;
        if !won {
            return Ok(match self.settled(id).await? {
                Some(decision) => Answer::AlreadySettled(decision),
                None => Answer::NotFound,
            });
        }
        let decision = if approve {
            Decision::Approved {
                by: device_id.to_string(),
            }
        } else {
            Decision::Denied {
                by: device_id.to_string(),
            }
        };
        self.events
            .append(
                Some(device_id),
                "approval.answered",
                json!({ "id": id, "approve": approve }),
            )
            .await?;
        if let Some(waiter) = lock(&self.waiters).remove(id) {
            let _ = waiter.send(decision.clone());
        }
        Ok(Answer::Answered(decision))
    }

    /// Approvals still waiting for an answer, oldest first.
    pub async fn pending(&self) -> Result<Vec<Pending>, StoreError> {
        let now = now_ms();
        self.store
            .call(move |conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, kind, summary, data, created_at, expires_at FROM approvals
                     WHERE status = 'pending' AND expires_at > ?1 ORDER BY created_at",
                )?;
                let rows = stmt.query_map([now], |row| {
                    let data: String = row.get(3)?;
                    Ok(Pending {
                        id: row.get(0)?,
                        kind: row.get(1)?,
                        summary: row.get(2)?,
                        data: serde_json::from_str(&data).unwrap_or(Value::Null),
                        created_at: row.get(4)?,
                        expires_at: row.get(5)?,
                    })
                })?;
                rows.collect()
            })
            .await
    }

    /// Denies every approval a previous run left pending. Whoever asked is
    /// gone, so an answer now would approve nothing. Run once at startup.
    pub async fn deny_orphaned(&self) -> Result<usize, StoreError> {
        let now = now_ms();
        let ids: Vec<String> = self
            .store
            .call(move |conn| {
                let tx = conn.transaction()?;
                let ids = {
                    let mut stmt =
                        tx.prepare("SELECT id FROM approvals WHERE status = 'pending'")?;
                    stmt.query_map([], |row| row.get(0))?
                        .collect::<rusqlite::Result<Vec<String>>>()?
                };
                tx.execute(
                    "UPDATE approvals SET status = 'denied', outcome = 'restart', answered_at = ?1
                     WHERE status = 'pending'",
                    [now],
                )?;
                tx.commit()?;
                Ok(ids)
            })
            .await?;
        for id in &ids {
            self.announce_unanswered(id, "restart").await?;
        }
        Ok(ids.len())
    }

    /// Marks an unanswered approval denied. If an answer landed first, returns
    /// that answer instead.
    async fn settle_unanswered(
        &self,
        id: &str,
        outcome: &'static str,
    ) -> Result<Decision, StoreError> {
        let (row_id, now) = (id.to_string(), now_ms());
        let changed = self
            .store
            .call(move |conn| {
                conn.execute(
                    "UPDATE approvals SET status = 'denied', outcome = ?1, answered_at = ?2
                     WHERE id = ?3 AND status = 'pending'",
                    rusqlite::params![outcome, now, row_id],
                )
            })
            .await?;
        if changed == 1 {
            self.announce_unanswered(id, outcome).await?;
            return Ok(Decision::TimedOut);
        }
        Ok(self.settled(id).await?.unwrap_or(Decision::TimedOut))
    }

    async fn announce_unanswered(&self, id: &str, reason: &str) -> Result<(), StoreError> {
        self.events
            .append(
                None,
                "approval.answered",
                json!({ "id": id, "approve": false, "reason": reason }),
            )
            .await
            .map(|_| ())
    }

    /// What an approval ended as. A pending row past its expiry counts as
    /// timed out; `None` means there is no such approval.
    async fn settled(&self, id: &str) -> Result<Option<Decision>, StoreError> {
        let id = id.to_string();
        let row = self
            .store
            .call(move |conn| {
                conn.query_row(
                    "SELECT status, outcome, answered_by FROM approvals WHERE id = ?1",
                    [id],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                        ))
                    },
                )
                .optional()
            })
            .await?;
        Ok(row.map(
            |(status, outcome, by)| match (status.as_str(), outcome.as_deref(), by) {
                ("approved", _, Some(by)) => Decision::Approved { by },
                ("denied", Some("answered"), Some(by)) => Decision::Denied { by },
                _ => Decision::TimedOut,
            },
        ))
    }
}

/// Denies the approval if the requester stops waiting (its task was
/// cancelled), so the request doesn't sit answerable with nobody behind it.
struct AbandonGuard {
    approvals: Approvals,
    id: Option<String>,
}

impl Drop for AbandonGuard {
    fn drop(&mut self) {
        let Some(id) = self.id.take() else { return };
        lock(&self.approvals.waiters).remove(&id);
        let approvals = self.approvals.clone();
        if let Ok(runtime) = tokio::runtime::Handle::try_current() {
            runtime.spawn(async move {
                if let Err(e) = approvals.settle_unanswered(&id, "abandoned").await {
                    tracing::error!("couldn't deny an abandoned approval: {e}");
                }
            });
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

// ---- routes ----

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/approvals", get(list))
        .route("/api/approvals/{id}", post(answer))
}

async fn list(State(state): State<AppState>, _: Authed<Read>) -> ApiResult<Json<Vec<Pending>>> {
    Ok(Json(state.approvals.pending().await?))
}

#[derive(Deserialize)]
struct AnswerBody {
    approve: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Answered {
    id: String,
    approve: bool,
    answered_by: String,
}

async fn answer(
    State(state): State<AppState>,
    Authed { device, .. }: Authed<Approve>,
    Path(id): Path<String>,
    Json(body): Json<AnswerBody>,
) -> ApiResult<Json<Answered>> {
    match state
        .approvals
        .answer(&id, &device.device_id, body.approve)
        .await?
    {
        Answer::Answered(_) => Ok(Json(Answered {
            id,
            approve: body.approve,
            answered_by: device.device_id,
        })),
        Answer::AlreadySettled(decision) => {
            let detail = match decision {
                Decision::Approved { by } => format!("approved by device {by}"),
                Decision::Denied { by } => format!("denied by device {by}"),
                Decision::TimedOut => "nobody answered in time, so it was denied".into(),
            };
            Err(ApiError::conflict("already answered").with_detail(detail))
        }
        Answer::NotFound => Err(ApiError::not_found()),
    }
}
