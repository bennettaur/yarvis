//! Setup, sign-in, freshness, tokens and revocation, with real WebAuthn
//! ceremonies.

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::{Harness, answer_registration, authenticator};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_rs::prelude::{RequestChallengeResponse, Url};
use yarvis_server::auth::Scope;
use yarvis_server::devices::add_token_device;
use yarvis_server::store::Store;

#[tokio::test]
async fn setup_then_login_and_the_setup_code_cannot_be_replayed() {
    let h = Harness::new().await;
    let mut pk = authenticator();

    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(status["setupRequired"], true);
    assert_eq!(status["rpId"], "localhost");
    let (st, _) = h.call("POST", "/api/auth/login/start", None, None).await;
    assert_eq!(st, StatusCode::CONFLICT, "nothing to sign in with yet");

    let wrong = json!({ "code": "WRONG-CODE0", "deviceName": "x" });
    let (st, body) = h
        .call("POST", "/api/auth/setup/start", None, Some(wrong))
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body["detail"], "4 tries left");

    let (st, body) = h
        .register(
            &mut pk,
            "/api/auth/setup",
            None,
            json!({ "code": h.setup_code.to_lowercase(), "deviceName": "laptop" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let laptop = body["token"].as_str().unwrap().to_string();
    assert_eq!(body["device"]["name"], "laptop");
    let (_, me) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(me["scopes"], json!(["read", "chat", "approve", "admin"]));
    assert!(me["verifiedAt"].is_i64());

    let replay = json!({ "code": h.setup_code, "deviceName": "attacker" });
    let (st, body) = h
        .call("POST", "/api/auth/setup/start", None, Some(replay))
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "no setup code is outstanding");
    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(status["setupRequired"], false);

    // Signing in with the same passkey makes a second, separate device.
    let phone = h.login(&mut pk, "phone").await;
    assert_ne!(phone, laptop);
    let (_, devices) = h.call("GET", "/api/devices", Some(&phone), None).await;
    let devices = devices.as_array().unwrap();
    let names: Vec<_> = devices
        .iter()
        .map(|d| d["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["laptop", "phone"]);
    assert!(devices.iter().all(|d| d["kind"] == "passkey"));
    assert!(
        devices
            .iter()
            .all(|d| d["passkeyId"] == devices[0]["passkeyId"])
    );
    assert_eq!(devices[1]["current"], true);
    assert!(
        devices.iter().all(|d| d["lastSeenAt"].is_i64()),
        "both devices have been seen"
    );
}

#[tokio::test]
async fn two_ceremonies_racing_on_one_setup_code_get_only_one_passkey() {
    let h = Harness::new().await;
    let (mut a, mut b) = (authenticator(), authenticator());
    let start = |name: &str| Some(json!({ "code": h.setup_code, "deviceName": name }));
    let (_, ra) = h
        .call("POST", "/api/auth/setup/start", None, start("a"))
        .await;
    let (_, rb) = h
        .call("POST", "/api/auth/setup/start", None, start("b"))
        .await;

    let finish_a = answer_registration(&mut a, &ra);
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/setup/finish",
            None,
            Some(finish_a.clone()),
        )
        .await;
    assert_eq!(st, StatusCode::OK);
    let (st, body) = h
        .call(
            "POST",
            "/api/auth/setup/finish",
            None,
            Some(answer_registration(&mut b, &rb)),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "{body}");
    assert_eq!(h.state.passkeys.passkeys().await.unwrap().len(), 1);

    // A finished ceremony can't be finished twice.
    let (st, _) = h
        .call("POST", "/api/auth/setup/finish", None, Some(finish_a))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
}

#[tokio::test]
async fn a_cancelled_prompt_does_not_use_up_the_setup_code() {
    let h = Harness::new().await;
    let start = json!({ "code": h.setup_code, "deviceName": "laptop" });
    let (st, _) = h
        .call("POST", "/api/auth/setup/start", None, Some(start))
        .await;
    assert_eq!(st, StatusCode::OK);
    // The user dismissed the prompt, so no finish arrives. The code still works.
    h.setup(&mut authenticator()).await;
}

#[tokio::test]
async fn the_setup_code_burns_after_five_wrong_guesses() {
    let h = Harness::new().await;
    for _ in 0..5 {
        let wrong = json!({ "code": "AAAAA-AAAAA", "deviceName": "x" });
        let (st, _) = h
            .call("POST", "/api/auth/setup/start", None, Some(wrong))
            .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }
    let right = json!({ "code": h.setup_code, "deviceName": "x" });
    let (st, body) = h
        .call("POST", "/api/auth/setup/start", None, Some(right))
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "no setup code is outstanding");
}

#[tokio::test]
async fn scopes_are_enforced_and_a_token_never_counts_as_fresh() {
    let h = Harness::new().await;
    let laptop = h.setup(&mut authenticator()).await;
    let (_, reader) = h.mint(&laptop, "dashboard", json!(["read"])).await;
    // What `yarvis-server device add --scopes admin` makes.
    let admin = add_token_device(
        &h.state.store,
        &h.state.events,
        "ops",
        &[Scope::Admin],
        None,
    )
    .await
    .unwrap()
    .token;

    let (st, _) = h.call("GET", "/api/approvals", Some(&reader), None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, body) = h
        .call(
            "POST",
            "/api/approvals/x",
            Some(&reader),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(
        body["error"].as_str().unwrap().contains("approve"),
        "{body}"
    );
    let (st, _) = h.call("GET", "/api/devices", Some(&reader), None).await;
    assert_eq!(st, StatusCode::FORBIDDEN);

    // An admin token can list devices, but nothing that needs a passkey check.
    let (st, _) = h.call("GET", "/api/devices", Some(&admin), None).await;
    assert_eq!(st, StatusCode::OK);
    let body = json!({ "name": "x", "scopes": ["admin"], "label": "x" });
    for (method, path) in [
        ("POST", "/api/devices/tokens"),
        ("POST", "/api/passkeys/register/start"),
        ("DELETE", "/api/devices/whatever"),
    ] {
        let (st, r) = h.call(method, path, Some(&admin), Some(body.clone())).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{path} must refuse a token");
        assert_eq!(r["error"], "reauth_required", "{path}: {r}");
    }
    let (st, r) = h
        .call("POST", "/api/auth/reverify/start", Some(&admin), None)
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(r["error"].as_str().unwrap().contains("passkey"), "{r}");

    let (st, _) = h
        .call("GET", "/api/devices/me", Some("made-up"), None)
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn admin_actions_need_a_recent_passkey_check() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let laptop_id = h.device_id(&laptop).await;
    let body = json!({ "name": "cli", "scopes": ["read"] });

    let (st, _) = h
        .call(
            "POST",
            "/api/devices/tokens",
            Some(&laptop),
            Some(body.clone()),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "fresh right after setup");

    // Age the last check past the window rather than waiting ten minutes.
    let id = laptop_id.clone();
    h.state
        .store
        .call(move |conn| conn.execute("UPDATE devices SET verified_at = 0 WHERE id = ?1", [id]))
        .await
        .unwrap();
    let (st, r) = h
        .call(
            "POST",
            "/api/devices/tokens",
            Some(&laptop),
            Some(body.clone()),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(r["error"], "reauth_required");

    let (st, r) = h
        .assert_with(&mut pk, "/api/auth/reverify", Some(&laptop), json!({}))
        .await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert!(r["verifiedAt"].is_i64());
    let (st, _) = h
        .call("POST", "/api/devices/tokens", Some(&laptop), Some(body))
        .await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn a_reverify_ceremony_belongs_to_the_device_that_started_it() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let phone = h.login(&mut pk, "phone").await;

    let (_, start) = h
        .call("POST", "/api/auth/reverify/start", Some(&laptop), None)
        .await;
    let options: RequestChallengeResponse =
        serde_json::from_value(start["options"].clone()).unwrap();
    let credential = pk
        .do_authentication(Url::parse(common::ORIGIN).unwrap(), options)
        .unwrap();
    let body = json!({ "ceremonyId": start["ceremonyId"], "credential": credential });
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/reverify/finish",
            Some(&phone),
            Some(body),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn revoking_a_device_takes_effect_on_its_next_request() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let laptop_id = h.device_id(&laptop).await;
    let phone = h.login(&mut pk, "phone").await;
    let phone_id = h.device_id(&phone).await;

    let path = format!("/api/devices/{phone_id}");
    let (st, _) = h.call("DELETE", &path, Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = h.call("GET", "/api/devices/me", Some(&phone), None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = h.call("DELETE", &path, Some(&laptop), None).await;
    assert_eq!(st, StatusCode::NOT_FOUND, "already revoked");

    let (_, devices) = h.call("GET", "/api/devices", Some(&laptop), None).await;
    let row = devices
        .as_array()
        .unwrap()
        .iter()
        .find(|d| d["id"] == phone_id)
        .unwrap()
        .clone();
    assert!(row["revokedAt"].is_i64(), "revoked devices stay listed");

    let revoked = h.events("device.revoked").await;
    assert_eq!(revoked.len(), 1);
    assert_eq!(revoked[0].device_id.as_deref(), Some(laptop_id.as_str()));
    assert_eq!(revoked[0].data["deviceId"], phone_id);
}

#[tokio::test]
async fn revocation_closes_an_open_event_stream() {
    let h = Harness::new().await;
    let laptop = h.setup(&mut authenticator()).await;
    let (bot_id, bot) = h.mint(&laptop, "bot", json!(["read"])).await;
    let url = format!("ws://{}/api/events", h.serve().await);

    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = json!({ "type": "auth", "token": bot, "since": 0 });
    ws.send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    // The backlog arriving shows the stream is authenticated and live.
    let first = ws.next().await.unwrap().unwrap();
    assert!(first.to_text().unwrap().contains("\"type\":\"event\""));

    let (st, _) = h
        .call(
            "DELETE",
            &format!("/api/devices/{bot_id}"),
            Some(&laptop),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK);

    let closed = tokio::time::timeout(Duration::from_secs(5), async {
        while let Some(message) = ws.next().await {
            match message {
                Ok(Message::Close(_)) | Err(_) => return true,
                Ok(_) => {}
            }
        }
        true
    })
    .await;
    assert_eq!(closed, Ok(true), "the stream closes within 5s");

    // And the token can't open a new one.
    let (mut ws, _) = tokio_tungstenite::connect_async(&url).await.unwrap();
    let hello = json!({ "type": "auth", "token": bot });
    ws.send(Message::Text(hello.to_string().into()))
        .await
        .unwrap();
    let Some(Ok(Message::Close(Some(frame)))) = ws.next().await else {
        panic!("expected a close frame");
    };
    assert_eq!(u16::from(frame.code), 4401);
}

#[tokio::test]
async fn add_a_passkey_from_a_signed_in_device() {
    let h = Harness::new().await;
    let (mut first, mut yubikey) = (authenticator(), authenticator());
    let laptop = h.setup(&mut first).await;

    let (st, body) = h
        .register(
            &mut yubikey,
            "/api/passkeys/register",
            Some(&laptop),
            json!({ "label": "yubikey" }),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let passkey_id = body["passkeyId"].as_str().unwrap().to_string();
    let desktop = h.login(&mut yubikey, "desktop").await;

    let (_, devices) = h.call("GET", "/api/devices", Some(&desktop), None).await;
    let desktop_row = devices.as_array().unwrap().last().unwrap().clone();
    assert_eq!(desktop_row["passkeyId"], passkey_id);

    // Other modules (vault unlock) find a passkey by the credential id an
    // assertion reports.
    let passkeys = h.state.passkeys.passkeys().await.unwrap();
    assert_eq!(passkeys.len(), 2);
    let record = &passkeys[1];
    let found = h
        .state
        .passkeys
        .passkey_by_credential_id(record.passkey.cred_id().as_slice())
        .await
        .unwrap()
        .unwrap();
    assert_eq!(found.id, passkey_id);
    assert_eq!(found.label, "yubikey");
    assert!(
        h.state
            .passkeys
            .passkey_by_credential_id(b"nope")
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn passkeys_and_devices_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let mut pk = authenticator();
    let laptop = {
        let h = Harness::on(Store::open(&path).unwrap()).await;
        h.setup(&mut pk).await
    };

    let h = Harness::on(Store::open(&path).unwrap()).await;
    assert_eq!(h.setup_code, "", "no setup code once a passkey exists");
    let (st, _) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK);
    h.login(&mut pk, "phone").await;
}

#[tokio::test]
async fn events_name_the_device_that_caused_them() {
    let h = Harness::new().await;
    let laptop = h.setup(&mut authenticator()).await;
    let laptop_id = h.device_id(&laptop).await;
    let (bot_id, _) = h
        .mint(&laptop, "telegram-bot", json!(["chat", "read"]))
        .await;

    let created = h.events("device.created").await;
    assert_eq!(created.len(), 2);
    assert_eq!(created[0].device_id.as_deref(), Some(laptop_id.as_str()));
    assert_eq!(created[1].data["deviceId"], bot_id);
    assert_eq!(
        created[1].device_id.as_deref(),
        Some(laptop_id.as_str()),
        "minting the token is the laptop's doing"
    );
    assert_eq!(created[1].data["scopes"], json!(["read", "chat"]));
}

#[tokio::test]
async fn the_sign_in_routes_are_rate_limited() {
    let h = Harness::new().await;
    let mut last = StatusCode::OK;
    for _ in 0..40 {
        last = h.call("GET", "/api/auth/status", None, None).await.0;
        if last == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    // Only the sign-in routes share that budget.
    let (st, _) = h.call("GET", "/api/health", None, None).await;
    assert_eq!(st, StatusCode::OK);
}
