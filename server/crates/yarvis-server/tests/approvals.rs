//! Approvals: the first answer wins, silence is a denial, and nothing left
//! pending survives a restart.

mod common;

use std::collections::HashSet;
use std::time::Duration;

use axum::http::StatusCode;
use common::{Harness, new_schema, store_on, until};
use serde_json::json;
use yarvis_server::approvals::{Approvals, Decision};
use yarvis_server::events::EventLog;

/// Waits for a requester, failing rather than stalling if it was never woken.
async fn settled(requester: tokio::task::JoinHandle<Decision>) -> Decision {
    tokio::time::timeout(Duration::from_secs(5), requester)
        .await
        .expect("the requester was woken")
        .unwrap()
}

/// Starts an approval in the background and waits until it is listed.
async fn ask(
    h: &Harness,
    summary: &str,
    timeout: Duration,
) -> (String, tokio::task::JoinHandle<Decision>) {
    let approvals = h.state.approvals.clone();
    let owned = summary.to_string();
    let task = tokio::spawn(async move {
        approvals
            .request("test", &owned, json!({ "n": 1 }), timeout)
            .await
            .unwrap()
    });
    let id = until("the approval to be listed", || async {
        let pending = h.state.approvals.pending().await.unwrap();
        pending
            .iter()
            .find(|p| p.summary == summary)
            .map(|p| p.id.clone())
    })
    .await;
    (id, task)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_first_answer_wins_and_the_event_names_its_device() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let phone = h.login("phone").await;
    let laptop_id = h.device_id(&laptop).await;
    let phone_id = h.device_id(&phone).await;

    let mut winners = HashSet::new();
    for round in 0..20 {
        let (id, requester) = ask(
            &h,
            &format!("sign commit #{round}"),
            Duration::from_secs(30),
        )
        .await;
        let path = format!("/api/approvals/{id}");
        // Separate tasks, so the two answers really race.
        let answer = |token: String, approve: bool| {
            let (state, path) = (h.state.clone(), path.clone());
            tokio::spawn(async move {
                let h = Harness {
                    state,
                    setup_code: String::new(),
                    totp_secret: Default::default(),
                    backup_codes: Default::default(),
                };
                h.call(
                    "POST",
                    &path,
                    Some(&token),
                    Some(json!({ "approve": approve })),
                )
                .await
            })
        };
        let (a, b) = (answer(laptop.clone(), true), answer(phone.clone(), false));
        let (a, b) = (a.await.unwrap(), b.await.unwrap());
        let (winner, loser) = match (a.0, b.0) {
            (StatusCode::OK, StatusCode::CONFLICT) => (&laptop_id, b.1),
            (StatusCode::CONFLICT, StatusCode::OK) => (&phone_id, a.1),
            other => panic!("exactly one answer should win, got {other:?}"),
        };
        assert!(
            loser["detail"].as_str().unwrap().contains(winner.as_str()),
            "the loser is told who won: {loser}"
        );
        winners.insert(winner.clone());

        let decision = settled(requester).await;
        if winner == &laptop_id {
            assert_eq!(
                decision,
                Decision::Approved {
                    by: laptop_id.clone(),
                    allow_for: None,
                }
            );
        } else {
            assert_eq!(
                decision,
                Decision::Denied {
                    by: phone_id.clone()
                }
            );
        }
        let answered: Vec<_> = h
            .events("approval.answered")
            .await
            .into_iter()
            .filter(|e| e.data["id"] == id)
            .collect();
        assert_eq!(answered.len(), 1, "one answer event per approval");
        assert_eq!(answered[0].device_id.as_ref(), Some(winner));
    }
    eprintln!("devices that won at least one race: {}", winners.len());
}

#[tokio::test]
async fn no_answer_in_time_is_a_denial_and_later_answers_get_409() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let decision = h
        .state
        .approvals
        .request("test", "push to main", json!({}), Duration::from_millis(50))
        .await
        .unwrap();
    assert_eq!(decision, Decision::Unanswered);
    assert!(h.state.approvals.pending().await.unwrap().is_empty());

    let requested = h.events("approval.requested").await;
    assert_eq!(requested.len(), 1);
    assert_eq!(requested[0].data["summary"], "push to main");
    let id = requested[0].data["id"].as_str().unwrap();
    let (st, body) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert!(
        body["detail"].as_str().unwrap().contains("in time"),
        "{body}"
    );

    let answered = h.events("approval.answered").await;
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0].device_id, None);
    assert_eq!(answered[0].data["reason"], "timeout");
}

#[tokio::test]
async fn pending_approvals_are_listed_and_unknown_ones_are_404() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let (_, reader) = h.mint(&laptop, "watch", json!(["read"])).await;
    let (id, requester) = ask(&h, "run rm -rf build/", Duration::from_secs(30)).await;

    let (st, list) = h.call("GET", "/api/approvals", Some(&reader), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(list[0]["id"], id);
    assert_eq!(list[0]["kind"], "test");
    assert_eq!(list[0]["data"]["n"], 1);
    assert!(list[0]["expiresAt"].as_i64() > list[0]["createdAt"].as_i64());

    let (st, _) = h
        .call(
            "POST",
            "/api/approvals/nope",
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND);
    let (st, _) = h
        .call(
            "POST",
            "/api/approvals/nope",
            Some(&laptop),
            Some(json!({ "approve": true, "allowForSecs": 60 })),
        )
        .await;
    assert_eq!(st, StatusCode::NOT_FOUND, "a duration doesn't change a 404");
    let (st, body) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert!(settled(requester).await.approved());
    let (_, list) = h.call("GET", "/api/approvals", Some(&reader), None).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn a_duration_is_refused_unless_the_request_offered_one() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let (id, requester) = ask(&h, "covers only itself", Duration::from_secs(30)).await;
    let path = format!("/api/approvals/{id}");

    let (st, list) = h.call("GET", "/api/approvals", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK);
    assert!(list[0].get("maxAllowForSecs").is_none(), "{list}");
    let (st, body) = h
        .call(
            "POST",
            &path,
            Some(&laptop),
            Some(json!({ "approve": true, "allowForSecs": 60 })),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
    // Refusing the duration recorded nothing, so a plain answer still lands.
    let (st, _) = h
        .call(
            "POST",
            &path,
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    assert!(settled(requester).await.approved());
}

#[tokio::test]
async fn a_duration_within_the_limit_reaches_the_requester() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let laptop_id = h.device_id(&laptop).await;
    let approvals = h.state.approvals.clone();
    let requester = tokio::spawn(async move {
        approvals
            .request_allowing_grant(
                "test",
                "may cover more",
                json!({}),
                Duration::from_secs(30),
                Duration::from_secs(900),
            )
            .await
            .unwrap()
    });
    let pending = until("the approval to be listed", || async {
        h.state
            .approvals
            .pending()
            .await
            .unwrap()
            .into_iter()
            .next()
    })
    .await;
    assert_eq!(pending.max_allow_for_secs, Some(900));
    let path = format!("/api/approvals/{}", pending.id);

    for refused in [
        json!({ "approve": true, "allowForSecs": 901 }),
        json!({ "approve": true, "allowForSecs": 0 }),
        json!({ "approve": false, "allowForSecs": 60 }),
    ] {
        let (st, body) = h.call("POST", &path, Some(&laptop), Some(refused)).await;
        assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");
    }
    let (st, body) = h
        .call(
            "POST",
            &path,
            Some(&laptop),
            Some(json!({ "approve": true, "allowForSecs": 900 })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(
        settled(requester).await,
        Decision::Approved {
            by: laptop_id,
            allow_for: Some(Duration::from_secs(900)),
        }
    );
    let answered = h.events("approval.answered").await;
    assert_eq!(
        answered[0].data["allowForSecs"], 900,
        "the full limit is allowed"
    );

    // A late answer is told it was already answered, duration or not, rather
    // than that its duration is wrong.
    for late in [
        json!({ "approve": true, "allowForSecs": 60 }),
        json!({ "approve": false, "allowForSecs": 60 }),
    ] {
        let (st, body) = h.call("POST", &path, Some(&laptop), Some(late)).await;
        assert_eq!(st, StatusCode::CONFLICT, "{body}");
    }
}

#[tokio::test]
async fn an_approval_whose_requester_stopped_waiting_is_denied() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let (id, requester) = ask(&h, "abandoned", Duration::from_secs(30)).await;
    requester.abort();

    until("the abandoned approval to leave the list", || async {
        h.state
            .approvals
            .pending()
            .await
            .unwrap()
            .is_empty()
            .then_some(())
    })
    .await;
    // The row is settled first and the event appended after, so the list
    // above can empty before the event lands.
    let answered = until("the abandoned approval's event", || async {
        let answered = h.events("approval.answered").await;
        (!answered.is_empty()).then_some(answered)
    })
    .await;
    assert_eq!(answered[0].data["reason"], "abandoned");
    let (st, _) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
}

#[tokio::test]
async fn approvals_left_pending_by_a_restart_are_denied() {
    let schema = new_schema().await;
    let store = store_on(&schema).await;
    let before = Approvals::new(store.clone(), EventLog::new(store.clone()));
    // A request that outlives this "run": the task is never awaited.
    let pending = tokio::spawn({
        let before = before.clone();
        async move {
            before
                .request("test", "left over", json!({}), Duration::from_secs(600))
                .await
        }
    });
    until("the approval to be stored", || async {
        (!before.pending().await.unwrap().is_empty()).then_some(())
    })
    .await;

    // A second server on the same database, as after a crash.
    let h = Harness::on(store_on(&schema).await).await;
    assert_eq!(h.state.approvals.deny_orphaned().await.unwrap(), 1);
    assert!(h.state.approvals.pending().await.unwrap().is_empty());
    let answered = h.events("approval.answered").await;
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0].data["reason"], "restart");
    let id = answered[0].data["id"].as_str().unwrap().to_string();
    let laptop = h.setup().await;
    let (st, _) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::CONFLICT,
        "nothing is left to act on a late yes"
    );
    pending.abort();
}

#[tokio::test]
async fn an_answer_after_the_deadline_is_refused_even_before_the_timeout_fires() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let (id, requester) = ask(&h, "late", Duration::from_secs(30)).await;
    // Past its deadline in the database, while the requester still waits.
    sqlx::query("UPDATE approvals SET expires_at = 0 WHERE id = $1")
        .bind(&id)
        .execute(h.state.store.db().unwrap())
        .await
        .unwrap();
    let (st, body) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{body}");
    assert!(
        body["detail"].as_str().unwrap().contains("in time"),
        "{body}"
    );
    let (_, list) = h.call("GET", "/api/approvals", Some(&laptop), None).await;
    assert_eq!(list, json!([]));
    requester.abort();
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_requester_and_the_answer_agree_when_an_answer_races_the_timeout() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let laptop_id = h.device_id(&laptop).await;
    for round in 0..50u64 {
        let approvals = h.state.approvals.clone();
        let summary = format!("race #{round}");
        let owned = summary.clone();
        let requester = tokio::spawn(async move {
            approvals
                .request(
                    "test",
                    &owned,
                    json!({}),
                    Duration::from_millis(1 + round % 5),
                )
                .await
                .unwrap()
        });
        let id = until("the request event", || async {
            h.events("approval.requested")
                .await
                .into_iter()
                .find(|e| e.data["summary"] == summary.as_str())
                .map(|e| e.data["id"].as_str().unwrap().to_string())
        })
        .await;
        let (st, _) = h
            .call(
                "POST",
                &format!("/api/approvals/{id}"),
                Some(&laptop),
                Some(json!({ "approve": true })),
            )
            .await;
        let decision = settled(requester).await;
        match st {
            StatusCode::OK => assert_eq!(
                decision,
                Decision::Approved {
                    by: laptop_id.clone(),
                    allow_for: None,
                }
            ),
            StatusCode::CONFLICT => assert_eq!(decision, Decision::Unanswered),
            other => panic!("unexpected {other}"),
        }
    }
}

/// A second connection holding the rows (a CLI run beside the server) makes
/// the sweep wait for it rather than fail or miss the row.
#[tokio::test]
async fn the_restart_sweep_waits_for_another_writer() {
    let schema = new_schema().await;
    let store = store_on(&schema).await;
    let approvals = Approvals::new(store.clone(), EventLog::new(store));
    let _pending = tokio::spawn({
        let approvals = approvals.clone();
        async move {
            approvals
                .request("test", "left over", json!({}), Duration::from_secs(600))
                .await
        }
    });
    until("the approval to be stored", || async {
        (!approvals.pending().await.unwrap().is_empty()).then_some(())
    })
    .await;

    let after = store_on(&schema).await;
    let writer = store_on(&schema).await;
    let mut held = writer.begin().await.unwrap();
    sqlx::query("UPDATE approvals SET summary = summary")
        .execute(&mut *held)
        .await
        .unwrap();
    let sweep = tokio::spawn(async move {
        Approvals::new(after.clone(), EventLog::new(after))
            .deny_orphaned()
            .await
    });
    // Holds the lock long enough for the sweep to run into it.
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !sweep.is_finished(),
        "the sweep went ahead of the held rows"
    );
    held.commit().await.unwrap();
    assert_eq!(sweep.await.unwrap().unwrap(), 1);
}
