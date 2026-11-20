//! Approvals: the first answer wins, silence is a denial, and nothing left
//! pending survives a restart.

mod common;

use std::collections::HashSet;
use std::time::Duration;

use axum::http::StatusCode;
use common::{Harness, authenticator, until};
use serde_json::json;
use yarvis_server::approvals::{Approvals, Decision};
use yarvis_server::events::EventLog;
use yarvis_server::store::Store;

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
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let phone = h.login(&mut pk, "phone").await;
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

        let decision = requester.await.unwrap();
        if winner == &laptop_id {
            assert_eq!(
                decision,
                Decision::Approved {
                    by: laptop_id.clone()
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
    let laptop = h.setup(&mut authenticator()).await;
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
    let laptop = h.setup(&mut authenticator()).await;
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
    let (st, body) = h
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&laptop),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert!(requester.await.unwrap().approved());
    let (_, list) = h.call("GET", "/api/approvals", Some(&reader), None).await;
    assert_eq!(list, json!([]));
}

#[tokio::test]
async fn an_approval_whose_requester_stopped_waiting_is_denied() {
    let h = Harness::new().await;
    let laptop = h.setup(&mut authenticator()).await;
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
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let store = Store::open(&path).unwrap();
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
    let h = Harness::on(Store::open(&path).unwrap()).await;
    assert_eq!(h.state.approvals.deny_orphaned().await.unwrap(), 1);
    assert!(h.state.approvals.pending().await.unwrap().is_empty());
    let answered = h.events("approval.answered").await;
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0].data["reason"], "restart");
    pending.abort();
}
