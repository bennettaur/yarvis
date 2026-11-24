//! Approvals: server code asks a question, any device with the `approve`
//! scope answers, and the first answer wins.
//!
//! [`Approvals::request`] is how other server code asks. It stores the
//! approval, announces it on the event log, and waits. No answer before the timeout is a denial, and so is
//! an approval left pending by a restart or by a requester that stopped
//! waiting: nothing is left to act on a late "yes".
//!
//! First-wins is one conditional `UPDATE ... WHERE status = 'pending'`. Of
//! two devices answering at once, the second waits on the first's row lock,
//! then re-checks the status and updates nothing.
//!
//! A requester can also let an approval cover later requests for a while
//! ([`Approvals::request_allowing_grant`]). The answer then names how long, up
//! to the requester's limit, and the requester decides what that covers. The
//! approvals here only record and pass it on.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use axum::extract::{Path, State};
use axum::routing::{get, post};
use axum::{Json, Router};
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
        /// How long the approver let this cover later requests, when the
        /// request allowed that and they chose to.
        allow_for: Option<Duration>,
    },
    Denied {
        by: String,
    },
    /// Nobody answered in time, the requester stopped waiting, or the server
    /// restarted. Treat as a no.
    Unanswered,
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
    /// The longest an approval may cover later requests, in seconds. Absent
    /// when it covers only this one.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max_allow_for_secs: Option<u32>,
}

pub enum Answer {
    Answered(Decision),
    /// Someone answered first, or it ended unanswered. Carries what it ended as.
    AlreadySettled(Decision),
    NotFound,
    /// The answer asked to cover later requests in a way this approval
    /// doesn't allow. Nothing was recorded.
    GrantRefused(String),
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

    #[cfg(test)]
    pub(crate) fn events(&self) -> &EventLog {
        &self.events
    }

    /// Asks every device with the `approve` scope and waits for the first
    /// answer, or `timeout`. `summary` is the one line a device shows; `data`
    /// is whatever detail the kind defines.
    pub async fn request(
        &self,
        kind: &str,
        summary: &str,
        data: Value,
        timeout: Duration,
    ) -> Result<Decision, StoreError> {
        self.ask(kind, summary, data, timeout, None).await
    }

    /// [`request`](Self::request), but the approver may also let it cover
    /// later requests for up to `max_allow_for`. The decision carries what
    /// they chose.
    pub async fn request_allowing_grant(
        &self,
        kind: &str,
        summary: &str,
        data: Value,
        timeout: Duration,
        max_allow_for: Duration,
    ) -> Result<Decision, StoreError> {
        let max_secs = u32::try_from(max_allow_for.as_secs()).unwrap_or(u32::MAX);
        self.ask(kind, summary, data, timeout, Some(max_secs)).await
    }

    async fn ask(
        &self,
        kind: &str,
        summary: &str,
        data: Value,
        timeout: Duration,
        max_allow_for_secs: Option<u32>,
    ) -> Result<Decision, StoreError> {
        let created_at = now_ms();
        let pending = Pending {
            id: new_id(),
            kind: kind.to_string(),
            summary: summary.to_string(),
            data,
            created_at,
            expires_at: created_at + timeout.as_millis() as i64,
            max_allow_for_secs,
        };
        // Registered before the row exists, since `pending()` lists the row at
        // once and an answer that arrives first must still find its waiter.
        let (tx, rx) = oneshot::channel();
        lock(&self.waiters).insert(pending.id.clone(), tx);
        let inserted = self.insert(&pending).await;
        if let Err(e) = inserted {
            lock(&self.waiters).remove(&pending.id);
            return Err(e);
        }
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

    async fn insert(&self, row: &Pending) -> Result<(), StoreError> {
        sqlx::query(
            "INSERT INTO approvals
                 (id, kind, summary, data, created_at, expires_at, status, max_allow_for_secs)
             VALUES ($1, $2, $3, $4, $5, $6, 'pending', $7)",
        )
        .bind(&row.id)
        .bind(&row.kind)
        .bind(&row.summary)
        .bind(row.data.to_string())
        .bind(row.created_at)
        .bind(row.expires_at)
        .bind(row.max_allow_for_secs.map(secs_to_db))
        .execute(self.store.db()?)
        .await?;
        Ok(())
    }

    /// Records a device's answer. Only the first one counts. `allow_for` lets
    /// an approval cover later requests, if the request allowed it.
    pub async fn answer(
        &self,
        id: &str,
        device_id: &str,
        approve: bool,
        allow_for: Option<Duration>,
    ) -> Result<Answer, StoreError> {
        if let Some(allow_for) = allow_for {
            let row: Option<(Option<i32>, bool)> = sqlx::query_as(
                "SELECT max_allow_for_secs, status = 'pending' AND expires_at > $2
                 FROM approvals WHERE id = $1",
            )
            .bind(id)
            .bind(now_ms())
            .fetch_optional(self.store.db()?)
            .await?;
            let Some((max_allow_for_secs, still_pending)) = row else {
                return Ok(Answer::NotFound);
            };
            // One that's settled falls through to the UPDATE, which matches
            // nothing, so a late answer gets the same 409 with or without a
            // duration.
            if still_pending
                && let Some(refusal) = grant_refusal(approve, allow_for, max_allow_for_secs)
            {
                return Ok(Answer::GrantRefused(refusal));
            }
        }
        let allow_for_secs = allow_for.map(|d| secs_to_db(d.as_secs()));
        let status = if approve { "approved" } else { "denied" };
        let won = sqlx::query(
            "UPDATE approvals
             SET status = $1, outcome = 'answered', answered_by = $2, answered_at = $3,
                 allow_for_secs = $5
             WHERE id = $4 AND status = 'pending' AND expires_at > $3
               -- The check above, again: it can be skipped when the clock
               -- moves between the two statements.
               AND ($5::INTEGER IS NULL
                    OR ($1 = 'approved' AND $5 > 0 AND $5 <= max_allow_for_secs))",
        )
        .bind(status)
        .bind(device_id)
        .bind(now_ms())
        .bind(id)
        .bind(allow_for_secs)
        .execute(self.store.db()?)
        .await?
        .rows_affected()
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
                allow_for,
            }
        } else {
            Decision::Denied {
                by: device_id.to_string(),
            }
        };
        let mut event = json!({ "id": id, "approve": approve });
        if let Some(allow_for) = allow_for {
            event["allowForSecs"] = json!(allow_for.as_secs());
        }
        self.events
            .append(Some(device_id), "approval.answered", event)
            .await?;
        if let Some(waiter) = lock(&self.waiters).remove(id) {
            let _ = waiter.send(decision.clone());
        }
        Ok(Answer::Answered(decision))
    }

    /// Approvals still waiting for an answer, oldest first.
    pub async fn pending(&self) -> Result<Vec<Pending>, StoreError> {
        type Row = (String, String, String, String, i64, i64, Option<i32>);
        let rows: Vec<Row> = sqlx::query_as(
            "SELECT id, kind, summary, data, created_at, expires_at, max_allow_for_secs
             FROM approvals
             WHERE status = 'pending' AND expires_at > $1 ORDER BY created_at",
        )
        .bind(now_ms())
        .fetch_all(self.store.db()?)
        .await?;
        Ok(rows
            .into_iter()
            .map(
                |(id, kind, summary, data, created_at, expires_at, max_allow_for_secs)| Pending {
                    id,
                    kind,
                    summary,
                    data: serde_json::from_str(&data).unwrap_or(Value::Null),
                    created_at,
                    expires_at,
                    max_allow_for_secs: max_allow_for_secs.and_then(|s| u32::try_from(s).ok()),
                },
            )
            .collect())
    }

    /// Denies every approval a previous run left pending. Whoever asked is
    /// gone, so an answer now would approve nothing. Run once at startup.
    pub async fn deny_orphaned(&self) -> Result<usize, StoreError> {
        let ids: Vec<String> = sqlx::query_scalar(
            "UPDATE approvals SET status = 'denied', outcome = 'restart', answered_at = $1
             WHERE status = 'pending' RETURNING id",
        )
        .bind(now_ms())
        .fetch_all(self.store.db()?)
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
        let changed = sqlx::query(
            "UPDATE approvals SET status = 'denied', outcome = $1, answered_at = $2
             WHERE id = $3 AND status = 'pending'",
        )
        .bind(outcome)
        .bind(now_ms())
        .bind(id)
        .execute(self.store.db()?)
        .await?
        .rows_affected();
        if changed == 1 {
            self.announce_unanswered(id, outcome).await?;
            return Ok(Decision::Unanswered);
        }
        Ok(self.settled(id).await?.unwrap_or(Decision::Unanswered))
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
    /// unanswered; `None` means there is no such approval.
    async fn settled(&self, id: &str) -> Result<Option<Decision>, StoreError> {
        type Row = (String, Option<String>, Option<String>, Option<i32>);
        let row: Option<Row> = sqlx::query_as(
            "SELECT status, outcome, answered_by, allow_for_secs FROM approvals WHERE id = $1",
        )
        .bind(id)
        .fetch_optional(self.store.db()?)
        .await?;
        Ok(row.map(|(status, outcome, by, allow_for)| {
            match (status.as_str(), outcome.as_deref(), by) {
                ("approved", _, Some(by)) => Decision::Approved {
                    by,
                    allow_for: allow_for
                        .and_then(|s| u64::try_from(s).ok())
                        .map(Duration::from_secs),
                },
                ("denied", Some("answered"), Some(by)) => Decision::Denied { by },
                _ => Decision::Unanswered,
            }
        }))
    }
}

/// Why an answer can't cover later requests, or `None` when it can.
/// `max_secs` is the requester's limit; NULL means it covers this one only.
fn grant_refusal(approve: bool, allow_for: Duration, max_secs: Option<i32>) -> Option<String> {
    if !approve {
        return Some("only an approval can cover later requests".into());
    }
    let Some(max_secs) = max_secs else {
        return Some("this approval covers only itself".into());
    };
    let secs = allow_for.as_secs();
    if secs == 0 {
        return Some("allowForSecs must be at least 1".into());
    }
    // A negative limit, which nothing writes, allows nothing.
    if secs > u64::try_from(max_secs).unwrap_or(0) {
        return Some(format!(
            "this approval can cover later requests for at most {max_secs} seconds"
        ));
    }
    None
}

/// Seconds as the `INTEGER` columns store them. Every value that reaches here
/// is held to a requester's limit, so the clamp is a safety net, not a limit.
fn secs_to_db(secs: impl Into<u64>) -> i32 {
    i32::try_from(secs.into()).unwrap_or(i32::MAX)
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
#[serde(rename_all = "camelCase")]
struct AnswerBody {
    approve: bool,
    /// Let this approval cover later requests for this many seconds.
    #[serde(default)]
    allow_for_secs: Option<u32>,
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
        .answer(
            &id,
            &device.device_id,
            body.approve,
            body.allow_for_secs.map(|s| Duration::from_secs(s.into())),
        )
        .await?
    {
        Answer::Answered(_) => Ok(Json(Answered {
            id,
            approve: body.approve,
            answered_by: device.device_id,
        })),
        Answer::AlreadySettled(decision) => {
            let detail = match decision {
                Decision::Approved { by, .. } => format!("approved by device {by}"),
                Decision::Denied { by } => format!("denied by device {by}"),
                Decision::Unanswered => "nobody answered in time, so it was denied".into(),
            };
            Err(ApiError::conflict("already answered").with_detail(detail))
        }
        Answer::NotFound => Err(ApiError::not_found()),
        Answer::GrantRefused(why) => Err(ApiError::bad_request(why)),
    }
}
