//! Setup, sign-in with the passphrase and a TOTP or backup code, freshness,
//! the account, tokens and revocation.

mod common;

use std::time::Duration;

use axum::http::StatusCode;
use common::{Harness, PASSPHRASE, base32_decode, code_now};
use futures_util::{SinkExt, StreamExt};
use serde_json::json;
use tokio_tungstenite::tungstenite::Message;
use yarvis_server::auth::Scope;
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::devices::add_token_device;
use yarvis_server::secret_blob::SecretBlob;
use yarvis_server::settings::SettingsStore;
use yarvis_server::store::Store;
use yarvis_server::vault::Vault;

fn login_body(passphrase: &str, code: &str, name: &str) -> serde_json::Value {
    json!({ "passphrase": passphrase, "code": code, "deviceName": name })
}

#[tokio::test]
async fn setup_needs_the_code_a_passphrase_and_a_working_authenticator() {
    let h = Harness::new().await;
    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(status["setupRequired"], true);

    let (st, body) = h
        .call(
            "POST",
            "/api/auth/setup/start",
            None,
            Some(
                json!({ "code": h.setup_code, "passphrase": "too short", "deviceName": "laptop" }),
            ),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST, "{body}");

    let enrollment = h.start_setup().await;
    assert!(
        enrollment["otpauthUri"]
            .as_str()
            .unwrap()
            .starts_with("otpauth://totp/")
    );
    assert!(enrollment["qrSvg"].as_str().unwrap().contains("<svg"));
    let secret = base32_decode(enrollment["secret"].as_str().unwrap());

    // A wrong first code keeps the enrollment, so the user can try again.
    let finish = |code: String| json!({ "enrollmentId": enrollment["enrollmentId"], "code": code });
    let wrong = format!(
        "{:06}",
        (code_now(&secret).parse::<u32>().unwrap() + 1) % 1_000_000
    );
    let (st, _) = h
        .call("POST", "/api/auth/setup/finish", None, Some(finish(wrong)))
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(
        status["setupRequired"], true,
        "nothing is created before a good code"
    );

    let (st, body) = h
        .call(
            "POST",
            "/api/auth/setup/finish",
            None,
            Some(finish(code_now(&secret))),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["backupCodes"].as_array().unwrap().len(), 10);
    let token = body["token"].as_str().unwrap();
    let (_, me) = h.call("GET", "/api/devices/me", Some(token), None).await;
    assert_eq!(
        me["scopes"],
        json!(["read", "chat", "terminal", "approve", "admin"])
    );
    assert!(me["verifiedAt"].is_i64());

    // Setup is closed now, and the code is spent.
    let again = json!({ "code": h.setup_code, "passphrase": PASSPHRASE, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/setup/start", None, Some(again))
        .await;
    assert_eq!(st, StatusCode::CONFLICT);
    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(status["setupRequired"], false);
    assert!(status.get("rpId").is_none());
}

#[tokio::test]
async fn the_setup_code_burns_after_five_wrong_guesses() {
    let h = Harness::new().await;
    for left in (0..5).rev() {
        let guess = json!({ "code": "AAAAA-AAAAA", "passphrase": PASSPHRASE, "deviceName": "x" });
        let (st, body) = h
            .call("POST", "/api/auth/setup/start", None, Some(guess))
            .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
        if left > 0 {
            assert_eq!(body["detail"], format!("{left} tries left"));
        }
    }
    let right = json!({ "code": h.setup_code, "passphrase": PASSPHRASE, "deviceName": "x" });
    let (st, body) = h
        .call("POST", "/api/auth/setup/start", None, Some(right))
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(body["error"], "no setup code is outstanding");
}

#[tokio::test]
async fn sign_in_needs_both_factors_and_never_says_which_was_wrong() {
    let h = Harness::new().await;
    h.setup().await;

    let code = h.code().await;
    let (st, wrong_passphrase) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body("not the passphrase", &code, "x")),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, wrong_code) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, "000000", "x")),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    assert_eq!(
        wrong_passphrase, wrong_code,
        "the two refusals look the same"
    );

    let code = h.code().await;
    let (st, body) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, &code, "phone")),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["device"]["name"], "phone");

    // The same code can't sign in twice.
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, &code, "again")),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "a replayed code signed in");
}

#[tokio::test]
async fn a_backup_code_signs_in_once() {
    let h = Harness::new().await;
    h.setup().await;
    let backup = h.backup_codes.lock().unwrap()[0].clone();
    let body = json!({ "passphrase": PASSPHRASE, "backupCode": backup.to_lowercase(), "deviceName": "spare" });
    let (st, r) = h
        .call("POST", "/api/auth/login", None, Some(body.clone()))
        .await;
    assert_eq!(st, StatusCode::OK, "{r}");
    let (st, _) = h.call("POST", "/api/auth/login", None, Some(body)).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "a backup code is single-use");
    let used = h.events("account.backup_code_used").await;
    assert_eq!(used[0].data["left"], 9);
}

#[tokio::test]
async fn ten_failed_sign_ins_lock_the_account_even_for_the_right_passphrase() {
    let h = Harness::new().await;
    h.setup().await;
    for _ in 0..10 {
        let (st, _) = h
            .call(
                "POST",
                "/api/auth/login",
                None,
                Some(login_body("wrong passphrase!", "000000", "x")),
            )
            .await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }
    let code = h.code().await;
    let (st, body) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, &code, "x")),
        )
        .await;
    assert_eq!(st, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(
        body["detail"].as_str().unwrap().contains("minutes"),
        "{body}"
    );
}

#[tokio::test]
async fn admin_actions_need_a_recent_code() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
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

    let (st, _) = h
        .call(
            "POST",
            "/api/auth/reverify",
            Some(&laptop),
            Some(json!({ "code": "000000" })),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::FORBIDDEN,
        "a wrong code doesn't make it fresh"
    );
    let code = h.code().await;
    let (st, r) = h
        .call(
            "POST",
            "/api/auth/reverify",
            Some(&laptop),
            Some(json!({ "code": code })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{r}");
    assert!(r["verifiedAt"].is_i64());
    let (st, _) = h
        .call("POST", "/api/devices/tokens", Some(&laptop), Some(body))
        .await;
    assert_eq!(st, StatusCode::OK);
}

#[tokio::test]
async fn changing_the_passphrase_needs_the_old_one_and_can_sign_out_the_rest() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let phone = h.login("phone").await;
    let new = "a whole new passphrase";

    let (st, _) = h
        .call(
            "POST",
            "/api/account/passphrase",
            Some(&laptop),
            Some(json!({ "currentPassphrase": "not it at all", "newPassphrase": new })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    let (st, body) = h
        .call(
            "POST",
            "/api/account/passphrase",
            Some(&laptop),
            Some(json!({ "currentPassphrase": PASSPHRASE, "newPassphrase": new })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(
        body["revokedDevices"],
        json!([]),
        "other devices stay by default"
    );
    let (st, _) = h.call("GET", "/api/devices/me", Some(&phone), None).await;
    assert_eq!(st, StatusCode::OK);

    let code = h.code().await;
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, &code, "x")),
        )
        .await;
    assert_eq!(
        st,
        StatusCode::UNAUTHORIZED,
        "the old passphrase still works"
    );
    let code = h.code().await;
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(new, &code, "x")),
        )
        .await;
    assert_eq!(st, StatusCode::OK);

    let (st, body) = h
        .call(
            "POST",
            "/api/account/passphrase",
            Some(&laptop),
            Some(json!({ "currentPassphrase": new, "newPassphrase": PASSPHRASE, "signOutOtherDevices": true })),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["revokedDevices"].as_array().unwrap().len(), 2);
    let (st, _) = h.call("GET", "/api/devices/me", Some(&phone), None).await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK, "this device stays signed in");
}

#[tokio::test]
async fn re_enrolling_totp_replaces_the_secret_once_a_code_confirms_it() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let (st, enrollment) = h
        .call("POST", "/api/account/totp/start", Some(&laptop), None)
        .await;
    assert_eq!(st, StatusCode::OK, "{enrollment}");
    let new_secret = base32_decode(enrollment["secret"].as_str().unwrap());

    // Another device can't finish this device's enrollment.
    let phone = h.login("phone").await;
    let finish =
        json!({ "enrollmentId": enrollment["enrollmentId"], "code": code_now(&new_secret) });
    let (st, _) = h
        .call(
            "POST",
            "/api/account/totp/finish",
            Some(&phone),
            Some(finish.clone()),
        )
        .await;
    assert_eq!(st, StatusCode::BAD_REQUEST);
    let (st, body) = h
        .call(
            "POST",
            "/api/account/totp/finish",
            Some(&laptop),
            Some(finish),
        )
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");

    let old_code = h.code().await;
    let (st, _) = h
        .call(
            "POST",
            "/api/auth/login",
            None,
            Some(login_body(PASSPHRASE, &old_code, "x")),
        )
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED, "the old secret still works");
    *h.totp_secret.lock().unwrap() = Some(new_secret);
    h.login("with the new one").await;
}

#[tokio::test]
async fn new_backup_codes_replace_the_old_ones() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let old = h.backup_codes.lock().unwrap()[0].clone();
    let (st, body) = h
        .call("POST", "/api/account/backup-codes", Some(&laptop), None)
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    let new = body["backupCodes"][0].as_str().unwrap().to_string();
    let backup =
        |code: &str| json!({ "passphrase": PASSPHRASE, "backupCode": code, "deviceName": "x" });
    let (st, _) = h
        .call("POST", "/api/auth/login", None, Some(backup(&old)))
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
    let (st, _) = h
        .call("POST", "/api/auth/login", None, Some(backup(&new)))
        .await;
    assert_eq!(st, StatusCode::OK);
    let (_, account) = h.call("GET", "/api/account", Some(&laptop), None).await;
    assert_eq!(account["backupCodesLeft"], 9);
}

#[tokio::test]
async fn signing_out_other_devices_keeps_only_this_one() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let phone = h.login("phone").await;
    let (_, bot) = h.mint(&laptop, "bot", json!(["read"])).await;
    let (st, body) = h
        .call("POST", "/api/account/sign-out-others", Some(&laptop), None)
        .await;
    assert_eq!(st, StatusCode::OK, "{body}");
    assert_eq!(body["revokedDevices"].as_array().unwrap().len(), 2);
    for token in [&phone, &bot] {
        let (st, _) = h.call("GET", "/api/devices/me", Some(token), None).await;
        assert_eq!(st, StatusCode::UNAUTHORIZED);
    }
    assert_eq!(h.events("device.revoked").await.len(), 2);
}

/// `yarvis-server auth reset` removes the account and prints a new setup code
/// the running server accepts; signed-in devices stay signed in.
#[tokio::test]
async fn auth_reset_reopens_setup_with_a_new_code() {
    let dir = tempfile::tempdir().unwrap();
    let config = dir.path().join("server.toml");
    let data_dir = dir.path().join("data");
    std::fs::write(&config, format!("[server]\ndata_dir = {:?}\n", data_dir)).unwrap();
    let db = data_dir.join("server.db");
    let mut h = Harness::on(Store::open(&db).unwrap()).await;
    let laptop = h.setup().await;

    let output = std::process::Command::new(env!("CARGO_BIN_EXE_yarvis-server"))
        .args(["--config", config.to_str().unwrap(), "auth", "reset"])
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let code = String::from_utf8(output.stdout).unwrap().trim().to_string();
    assert_eq!(
        std::fs::read_to_string(data_dir.join("setup-code"))
            .unwrap()
            .trim(),
        code
    );

    let (_, status) = h.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(status["setupRequired"], true);
    let (st, _) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK, "devices stay signed in");
    h.setup_code = code;
    h.setup().await;
}

/// Switching the secrets backend needs a fresh passkey; writing a secret needs
/// only `admin`. With `secrets.backend` set in the config, a switch that gets
/// past the check is refused with 409, so no real store is touched.
#[tokio::test]
async fn a_backend_switch_needs_a_fresh_device_and_a_secret_write_does_not() {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    config.secrets.backend = Some(SecretBackendKind::Vault);
    let created = Vault::init(dir.path(), false, "a vault passphrase").unwrap();
    let mut h = Harness::with_config(config).await;
    h.state.settings = SettingsStore::new(dir.path().join("settings.json"));
    h.state.secrets = SecretBlob::from_config(
        Some(SecretBackendKind::Vault),
        h.state.settings.clone(),
        &h.state.vault,
    );
    let laptop = h.setup().await;
    let cli = add_token_device(
        &h.state.store,
        &h.state.events,
        "tauri",
        &[Scope::Admin],
        None,
    )
    .await
    .unwrap()
    .token;
    let switch = json!({ "backend": "keychain" });

    let (st, body) = h
        .call(
            "POST",
            "/api/core/set_secret_backend",
            Some(&cli),
            Some(switch.clone()),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "reauth_required");
    let (st, body) = h
        .call(
            "POST",
            "/api/core/set_secret_backend",
            Some(&laptop),
            Some(switch),
        )
        .await;
    assert_eq!(st, StatusCode::CONFLICT, "{body}");

    h.state
        .vault
        .unlock_with_recovery(&created.recovery_key)
        .unwrap();
    let (st, body) = h
        .call(
            "POST",
            "/api/core/set_secret",
            Some(&cli),
            Some(json!({ "key": "anthropic_api_key", "value": "sk-test" })),
        )
        .await;
    assert_eq!(st, StatusCode::NO_CONTENT, "{body}");
    assert_eq!(
        h.state.secrets.read_root().unwrap()["anthropic_api_key"],
        "sk-test"
    );
}

#[tokio::test]
async fn scopes_are_enforced_and_a_token_never_counts_as_fresh() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
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

    // An admin token can list devices, but nothing that needs a fresh device.
    let (st, _) = h.call("GET", "/api/devices", Some(&admin), None).await;
    assert_eq!(st, StatusCode::OK);
    let body = json!({ "name": "x", "scopes": ["admin"] });
    for (method, path) in [
        ("POST", "/api/devices/tokens"),
        ("DELETE", "/api/devices/whatever"),
        ("POST", "/api/account/passphrase"),
        ("POST", "/api/account/totp/start"),
        ("POST", "/api/account/backup-codes"),
        ("POST", "/api/account/sign-out-others"),
    ] {
        let (st, r) = h.call(method, path, Some(&admin), Some(body.clone())).await;
        assert_eq!(st, StatusCode::FORBIDDEN, "{path} must refuse a token");
        assert_eq!(r["error"], "reauth_required", "{path}: {r}");
    }
    // Not even with a good code: a token wasn't made by a sign-in.
    let code = h.code().await;
    let (st, r) = h
        .call(
            "POST",
            "/api/auth/reverify",
            Some(&admin),
            Some(json!({ "code": code })),
        )
        .await;
    assert_eq!(st, StatusCode::FORBIDDEN);
    assert!(r["error"].as_str().unwrap().contains("passphrase"), "{r}");

    let (st, _) = h
        .call("GET", "/api/devices/me", Some("made-up"), None)
        .await;
    assert_eq!(st, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn revoking_a_device_takes_effect_on_its_next_request() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
    let laptop_id = h.device_id(&laptop).await;
    let phone = h.login("phone").await;
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
        .find(|d| d["deviceId"] == phone_id)
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
    let laptop = h.setup().await;
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
async fn the_account_and_devices_survive_a_restart() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("server.db");
    let (laptop, secret) = {
        let h = Harness::on(Store::open(&path).unwrap()).await;
        let laptop = h.setup().await;
        (laptop, h.totp_secret.lock().unwrap().clone())
    };

    let h = Harness::on(Store::open(&path).unwrap()).await;
    *h.totp_secret.lock().unwrap() = secret;
    assert_eq!(h.setup_code, "", "no setup code once the account exists");
    let (st, _) = h.call("GET", "/api/devices/me", Some(&laptop), None).await;
    assert_eq!(st, StatusCode::OK);
    h.login("phone").await;
}

#[tokio::test]
async fn events_name_the_device_that_caused_them() {
    let h = Harness::new().await;
    let laptop = h.setup().await;
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
    let guess = json!({ "passphrase": "nobody knows this", "code": "000000", "deviceName": "x" });
    for _ in 0..40 {
        last = h
            .call("POST", "/api/auth/login", None, Some(guess.clone()))
            .await
            .0;
        if last == StatusCode::TOO_MANY_REQUESTS {
            break;
        }
    }
    assert_eq!(last, StatusCode::TOO_MANY_REQUESTS);
    let guess = json!({ "code": h.setup_code, "passphrase": PASSPHRASE, "deviceName": "x" });
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
async fn the_setup_code_file_is_private_and_goes_once_the_code_is_used() {
    let dir = tempfile::tempdir().unwrap();
    let file = dir.path().join("setup-code");
    let state = yarvis_server::AppState::new(
        yarvis_server::config::Config::default(),
        Store::open_in_memory().unwrap(),
    );
    let code = state
        .account
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
    let enrollment = state
        .account
        .start_setup(&code, PASSPHRASE.to_string().into(), "laptop".into())
        .await
        .unwrap()
        .unwrap();
    let secret = base32_decode(&enrollment.secret_base32);
    state
        .account
        .finish_setup(&enrollment.id, &code_now(&secret))
        .await
        .unwrap()
        .unwrap();
    assert!(!file.exists());
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
