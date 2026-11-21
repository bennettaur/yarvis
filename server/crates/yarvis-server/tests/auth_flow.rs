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
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
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
    assert_eq!(
        me["scopes"],
        json!(["read", "chat", "terminal", "approve", "admin"])
    );
    assert!(me["verifiedAt"].is_i64());

    let replay = json!({ "code": h.setup_code, "deviceName": "attacker" });
    let (st, body) = h
        .call("POST", "/api/auth/setup/start", None, Some(replay))
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    assert_eq!(body["error"], "setup is done");
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
    assert_eq!(st, StatusCode::CONFLICT, "{body}");
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
    let (st, body) = h
        .call(
            "POST",
            "/api/devices/tokens",
            Some(&laptop),
            Some(json!({ "name": "ops", "scopes": ["read", "admin"] })),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::BAD_REQUEST,
        "only the CLI makes admin tokens"
    );
    assert!(body["error"].as_str().unwrap().contains("admin"), "{body}");
    let (st, body) = h
        .call(
            "POST",
            "/api/devices/tokens",
            Some(&laptop),
            Some(json!({ "name": "bot", "scopes": ["read", "terminal"] })),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::BAD_REQUEST,
        "only the CLI makes terminal tokens"
    );
    assert!(
        body["error"].as_str().unwrap().contains("terminal"),
        "{body}"
    );

    // An admin token can list devices, but nothing that needs a passkey check.
    let (st, _) = h.call("GET", "/api/devices", Some(&admin), None).await;
    assert_eq!(st, StatusCode::OK);
    let body = json!({ "name": "x", "scopes": ["admin"], "label": "x" });
    for (method, path) in [
        ("POST", "/api/devices/tokens"),
        ("POST", "/api/passkeys/register/start"),
        ("DELETE", "/api/devices/whatever"),
        ("DELETE", "/api/passkeys/whatever"),
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

    // Other modules find a passkey by the credential id an
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
    let h = Harness::with_default_limit(Store::open_in_memory().unwrap()).await;
    let mut last = StatusCode::OK;
    for _ in 0..40 {
        last = h.call("POST", "/api/auth/login/start", None, None).await.0;
        if last == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    let guess = json!({ "code": h.setup_code, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/setup/start", None, Some(guess))
        .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "setup shares the budget");
    // Polling status doesn't spend it, so a polling client can't lock the
    // owner out, and status stays answerable.
    let (st, _) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn a_login_assertion_finishes_only_its_own_ceremony_once() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let (_, a) = h.call("POST", "/api/auth/login/start", None, None).await;
    let (_, b) = h.call("POST", "/api/auth/login/start", None, None).await;

    let options: RequestChallengeResponse = serde_json::from_value(a["options"].clone()).unwrap();
    let answer_a = pk
        .do_authentication(Url::parse(common::ORIGIN).unwrap(), options)
        .unwrap();
    let swapped =
        json!({ "ceremonyId": b["ceremonyId"], "credential": answer_a, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/login/finish", None, Some(swapped))
        .await;
    assert_eq!(
        st,
        StatusCode::UNAUTHORIZED,
        "A's answer doesn't fit B's challenge"
    );

    let body = json!({ "ceremonyId": a["ceremonyId"], "credential": answer_a, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/login/finish", None, Some(body.clone()))
        .await;
    assert_eq!(st, StatusCode::OK);
    let (st, _) = h
        .call("POST", "/api/auth/login/finish", None, Some(body))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "a ceremony finishes once");

    // A reverify ceremony can't be finished as a login.
    let (_, start) = h
        .call("POST", "/api/auth/reverify/start", Some(&laptop), None)
        .await;
    let options: RequestChallengeResponse =
        serde_json::from_value(start["options"].clone()).unwrap();
    let credential = pk
        .do_authentication(Url::parse(common::ORIGIN).unwrap(), options)
        .unwrap();
    let body =
        json!({ "ceremonyId": start["ceremonyId"], "credential": credential, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/login/finish", None, Some(body))
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);

    let (_, devices) = h.call("GET", "/api/devices", Some(&laptop), None).await;
    assert_eq!(
        devices.as_array().unwrap().len(),
        2,
        "exactly one login made a device"
    );
}

#[tokio::test]
async fn an_add_passkey_ceremony_belongs_to_the_device_that_started_it() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    let phone = h.login(&mut pk, "phone").await;
    let (_, start) = h
        .call(
            "POST",
            "/api/passkeys/register/start",
            Some(&laptop),
            Some(json!({ "label": "yubikey" })),
        )
        .await;
    let body = answer_registration(&mut authenticator(), &start);
    let (st, _) = h
        .call(
            "POST",
            "/api/passkeys/register/finish",
            Some(&phone),
            Some(body),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert_eq!(h.state.passkeys.passkeys().await.unwrap().len(), 1);
}

#[tokio::test]
async fn a_flood_of_sign_in_starts_pushes_out_old_ones_but_not_signed_in_ones() {
    let h = Harness::new().await;
    let mut pk = authenticator();
    let laptop = h.setup(&mut pk).await;
    // The owner's re-check, started before the flood.
    let (_, reverify) = h
        .call("POST", "/api/auth/reverify/start", Some(&laptop), None)
        .await;
    let (_, first_login) = h.call("POST", "/api/auth/login/start", None, None).await;
    for _ in 0..300 {
        let (st, _) = h.call("POST", "/api/auth/login/start", None, None).await;
        assert_eq!(st, StatusCode::OK, "new sign-ins are never refused");
    }

    let finish = |start: &serde_json::Value, pk: &mut SoftPasskey| {
        let options: RequestChallengeResponse =
            serde_json::from_value(start["options"].clone()).unwrap();
        let credential = pk
            .do_authentication(Url::parse(common::ORIGIN).unwrap(), options)
            .unwrap();
        json!({ "ceremonyId": start["ceremonyId"], "credential": credential, "deviceName": "x" })
    };
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/login/finish",
            None,
            Some(finish(&first_login, &mut pk)),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::BAD_REQUEST,
        "the oldest sign-in was pushed out"
    );
    let (st, r) = h
        .call(
            "POST",
            "/api/auth/reverify/finish",
            Some(&laptop),
            Some(finish(&reverify, &mut pk)),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{r}");
}

#[tokio::test]
async fn the_setup_code_file_is_private_and_goes_once_the_code_is_used() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("setup-code");
    let state = yarvis_server::AppState::new(
        yarvis_server::config::Config::default(),
        Store::open_in_memory().unwrap(),
    );
    let code = state
        .passkeys
        .issue_setup_code_if_needed(Some(&file))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(std::fs::read_to_string(&file).unwrap().trim(), code);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(&file).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
    }
    let hash = state.passkeys.check_setup_code(&code).unwrap();
    assert!(state.passkeys.consume_setup_code(&hash));
    assert!(!file.exists());
}

#[tokio::test]
async fn removing_a_passkey_signs_out_its_devices() {
    let h = Harness::new().await;
    let (mut first, mut yubikey) = (authenticator(), authenticator());
    let laptop = h.setup(&mut first).await;
    let laptop_passkey = h.state.passkeys.passkeys().await.unwrap()[0].id.clone();
    let (_, body) = h
        .register(
            &mut yubikey,
            "/api/passkeys/register",
            Some(&laptop),
            json!({ "label": "attacker" }),
        )
        .await;
    let added = body["passkeyId"].as_str().unwrap().to_string();
    let via_added = h.login(&mut yubikey, "attacker").await;
    let via_added_id = h.device_id(&via_added).await;

    let (_, list) = h.call("GET", "/api/passkeys", Some(&laptop), None).await;
    let labels: Vec<_> = list
        .as_array()
        .unwrap()
        .iter()
        .map(|p| p["label"].clone())
        .collect();
    assert_eq!(labels, [json!("laptop"), json!("attacker")]);

    let (st, body) = h
        .call(
            "DELETE",
            &format!("/api/passkeys/{added}"),
            Some(&laptop),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["revokedDevices"], json!([via_added_id]));
    let (st, _) = h
        .call("GET", "/api/devices/me", Some(&via_added), None)
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK, "other passkeys' devices stay");

    let (st, _) = h
        .call(
            "DELETE",
            &format!("/api/passkeys/{laptop_passkey}"),
            Some(&laptop),
            None,
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "the last passkey stays");
}

#[tokio::test]
async fn the_device_add_command_prints_a_working_token() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("server.toml");
    let data_dir = dir.path().join("data");
    std::fs::write(&config, format!("[server]\ndata_dir = {:?}\n", data_dir)).unwrap();
    let run = |scopes: &str| {
        std::process::Command::new(env!("CARGO_BIN_EXE_yarvis-server"))
            .args(["--config", config.to_str().unwrap(), "device", "add"])
            .args(["--name", "Tauri on test", "--scopes", scopes])
            .output()
            .unwrap()
    };

    let output = run("read,chat");
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(stdout.lines().count(), 1, "only the token goes to stdout");
    let token = stdout.trim();

    let h = Harness::on(Store::open(&data_dir.join("server.db")).unwrap()).await;
    let (st, me) = h.call("GET", "/api/devices/me", Some(token), None).await;
    assert_eq!(st, StatusCode::OK);
    assert_eq!(me["scopes"], json!(["read", "chat"]));
    assert_eq!(me["name"], "Tauri on test");

    let output = run("read,root");
    assert!(!output.status.success());
    assert!(output.stdout.is_empty());
}
