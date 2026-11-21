//! The vault routes: unlocking with the recovery key and with a passkey's
//! PRF output, locking, wrappers, events, and the ssh-agent switch.
//!
//! The software passkey can't compute PRF (webauthn-authenticator-rs ignores
//! the extension), so these tests send a fixed 32-byte stand-in as
//! `prfFirst`. That covers everything the server does with a real one: the
//! server never sees how the browser got the value, and only checks that it
//! opens a wrapper after the assertion it came with verifies.

mod common;

use std::os::unix::fs::{FileTypeExt, PermissionsExt};

use axum::http::StatusCode;
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use common::{Harness, ORIGIN, authenticator};
use serde_json::{Value, json};
use tempfile::TempDir;
use webauthn_authenticator_rs::WebauthnAuthenticator;
use webauthn_authenticator_rs::softpasskey::SoftPasskey;
use webauthn_rs::prelude::{RequestChallengeResponse, Url};
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::secret_store::SecretError;
use yarvis_server::ssh_agent;
use yarvis_server::vault::{SIGNING_KEY_SECRET, Vault};

struct VaultHarness {
    harness: Harness,
    dir: TempDir,
    recovery_key: String,
}

async fn vault_harness(agent_enabled: bool) -> VaultHarness {
    let v = vault_harness_without_a_vault(agent_enabled).await;
    let created = Vault::init(v.dir.path(), agent_enabled).unwrap();
    VaultHarness {
        recovery_key: created.recovery_key.expose().to_string(),
        ..v
    }
}

/// The vault backend, before `vault init` has run.
async fn vault_harness_without_a_vault(agent_enabled: bool) -> VaultHarness {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    config.secrets.backend = SecretBackendKind::Vault;
    config.ssh_agent.enabled = agent_enabled;
    config.validate().unwrap();
    VaultHarness {
        harness: Harness::with_config(config).await,
        dir,
        recovery_key: String::new(),
    }
}

impl VaultHarness {
    async fn unlock_with_recovery(&self, token: &str) -> (StatusCode, Value) {
        self.harness
            .call(
                "POST",
                "/api/vault/unlock/recovery",
                Some(token),
                Some(json!({ "recoveryKey": self.recovery_key })),
            )
            .await
    }

    async fn state(&self, token: &str) -> String {
        let (status, body) = self
            .harness
            .call("GET", "/api/vault/status", Some(token), None)
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
        body["state"].as_str().unwrap().to_string()
    }

    /// Runs a PRF ceremony at `path` (`/api/vault/unlock` or
    /// `/api/vault/wrappers/passkey`). Returns the PRF salts the server
    /// offered and the finish response.
    async fn prf_ceremony(
        &self,
        pk: &mut SoftPasskey,
        path: &str,
        token: &str,
        start_body: Option<Value>,
        prf_first: Option<&str>,
    ) -> (Value, StatusCode, Value) {
        let (status, start) = self
            .harness
            .call("POST", &format!("{path}/start"), Some(token), start_body)
            .await;
        assert_eq!(status, StatusCode::OK, "{path}/start: {start}");
        let salts = start["options"]["publicKey"]["extensions"]["prf"]["evalByCredential"].clone();
        let options: RequestChallengeResponse =
            serde_json::from_value(start["options"].clone()).unwrap();
        let credential = pk
            .do_authentication(Url::parse(ORIGIN).unwrap(), options)
            .unwrap();
        let (status, body) = self
            .harness
            .call(
                "POST",
                &format!("{path}/finish"),
                Some(token),
                Some(json!({
                    "ceremonyId": start["ceremonyId"],
                    "credential": credential,
                    "prfFirst": prf_first,
                })),
            )
            .await;
        (salts, status, body)
    }
}

fn stand_in_prf(seed: u8) -> String {
    B64.encode([seed; 32])
}

#[tokio::test]
async fn every_vault_route_is_404_without_the_vault_backend() {
    let harness = Harness::new().await;
    let token = harness.setup(&mut authenticator()).await;
    for (method, path) in [
        ("GET", "/api/vault/status"),
        ("POST", "/api/vault/unlock/start"),
        ("POST", "/api/vault/unlock/recovery"),
        ("POST", "/api/vault/lock"),
        ("GET", "/api/vault/ssh-agent"),
        ("DELETE", "/api/vault/wrappers/recovery"),
    ] {
        let (status, _) = harness
            .call(method, path, Some(&token), Some(json!({})))
            .await;
        assert_eq!(status, StatusCode::NOT_FOUND, "{method} {path}");
    }
}

#[tokio::test]
async fn recovery_unlock_and_lock_gate_the_secrets_and_append_events() {
    let v = vault_harness(false).await;
    let token = v.harness.setup(&mut authenticator()).await;
    let backend = v.harness.state.vault.secret_backend();

    assert_eq!(v.state(&token).await, "locked");
    let (_, auth) = v.harness.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(auth["vault"], "locked");
    assert!(matches!(backend.read_root(), Err(SecretError::Locked)));

    let wrong = B64.encode([0u8; 32]);
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/unlock/recovery",
            Some(&token),
            Some(json!({ "recoveryKey": wrong })),
        )
        .await;
    assert_eq!(status, StatusCode::UNAUTHORIZED);
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/unlock/recovery",
            Some(&token),
            Some(json!({ "recoveryKey": "not a key" })),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST);
    assert!(v.harness.events("vault.unlocked").await.is_empty());

    let (status, body) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(v.state(&token).await, "unlocked");
    let (_, auth) = v.harness.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(auth["vault"], "unlocked");
    backend.write_root(r#"{"anthropic_api_key":"k"}"#).unwrap();
    let (status, _) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::CONFLICT, "a second unlock");

    let unlocked = v.harness.events("vault.unlocked").await;
    assert_eq!(unlocked.len(), 1);
    assert_eq!(unlocked[0].data["via"], "recovery");
    let device_id = v.harness.device_id(&token).await;
    assert_eq!(unlocked[0].device_id.as_deref(), Some(device_id.as_str()));

    let (status, _) = v
        .harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(v.state(&token).await, "locked");
    assert!(matches!(backend.read_root(), Err(SecretError::Locked)));
    let locked = v.harness.events("vault.locked").await;
    assert_eq!(locked.len(), 1);
    assert_eq!(locked[0].device_id.as_deref(), Some(device_id.as_str()));

    // Locking a locked vault is harmless and isn't announced again.
    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert_eq!(v.harness.events("vault.locked").await.len(), 1);

    // The blob written while unlocked is on disk, encrypted.
    let on_disk = std::fs::read_to_string(v.dir.path().join("vault.json")).unwrap();
    assert!(!on_disk.contains("anthropic_api_key"));
    v.unlock_with_recovery(&token).await;
    assert_eq!(
        backend.read_root().unwrap().as_deref(),
        Some(r#"{"anthropic_api_key":"k"}"#)
    );
}

#[tokio::test]
async fn unlocking_and_locking_need_admin() {
    let v = vault_harness(false).await;
    let token = v.harness.setup(&mut authenticator()).await;
    let (_, reader) = v.harness.mint(&token, "reader", json!(["read"])).await;
    let (status, _) = v.unlock_with_recovery(&reader).await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, _) = v
        .harness
        .call("POST", "/api/vault/lock", Some(&reader), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(v.state(&reader).await, "locked");
}

#[tokio::test]
async fn a_passkey_wrapper_unlocks_with_its_prf_output_only() {
    let v = vault_harness(false).await;
    let mut pk = authenticator();
    let token = v.harness.setup(&mut pk).await;

    let (status, body) = v
        .harness
        .call("POST", "/api/vault/unlock/start", Some(&token), None)
        .await;
    assert_eq!(
        status,
        StatusCode::CONFLICT,
        "no passkey wrapper yet: {body}"
    );

    // Enrolling needs the vault unlocked.
    let (_, passkeys) = v
        .harness
        .call("GET", "/api/passkeys", Some(&token), None)
        .await;
    let passkey_id = passkeys[0]["id"].as_str().unwrap().to_string();
    let enroll = json!({ "passkeyId": passkey_id });
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/start",
            Some(&token),
            Some(enroll.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    v.unlock_with_recovery(&token).await;

    let (enroll_salts, status, body) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/wrappers/passkey",
            &token,
            Some(enroll.clone()),
            Some(&stand_in_prf(7)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let wrapper_id = body["wrapperId"].as_str().unwrap().to_string();
    let enroll_salts = enroll_salts.as_object().unwrap().clone();
    assert_eq!(enroll_salts.len(), 1);

    let (_, status_body) = v
        .harness
        .call("GET", "/api/vault/status", Some(&token), None)
        .await;
    let wrapper = status_body["wrappers"]
        .as_array()
        .unwrap()
        .iter()
        .find(|w| w["id"] == wrapper_id.as_str())
        .unwrap()
        .clone();
    assert_eq!(wrapper["kind"], "passkey");
    assert_eq!(wrapper["passkeyId"], passkey_id.as_str());

    // A second wrapper for the same passkey is refused.
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/start",
            Some(&token),
            Some(enroll),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;

    // The unlock offers the same salt the wrapper was made with.
    let (unlock_salts, status, _) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/unlock",
            &token,
            None,
            Some(&stand_in_prf(8)),
        )
        .await;
    assert_eq!(unlock_salts.as_object().unwrap(), &enroll_salts);
    assert_eq!(status, StatusCode::UNAUTHORIZED, "the wrong PRF output");
    assert_eq!(v.state(&token).await, "locked");
    let unlocks_so_far = v.harness.events("vault.unlocked").await.len();
    assert_eq!(unlocks_so_far, 1, "only the recovery unlock");

    let (_, status, body) = v
        .prf_ceremony(&mut pk, "/api/vault/unlock", &token, None, None)
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no PRF output: {body}");
    assert!(body["error"].as_str().unwrap().contains("PRF"), "{body}");

    let (_, status, body) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/unlock",
            &token,
            None,
            Some(&stand_in_prf(7)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(v.state(&token).await, "unlocked");
    let unlocked = v.harness.events("vault.unlocked").await;
    let last = unlocked.last().unwrap();
    assert_eq!(last.data["via"], "passkey");
    assert_eq!(last.data["passkeyId"], passkey_id.as_str());
}

#[tokio::test]
async fn a_ceremony_belongs_to_the_device_that_started_it() {
    let v = vault_harness(false).await;
    let mut pk = authenticator();
    let token = v.harness.setup(&mut pk).await;
    let other = v.harness.login(&mut pk, "phone").await;
    v.unlock_with_recovery(&token).await;
    let (_, passkeys) = v
        .harness
        .call("GET", "/api/passkeys", Some(&token), None)
        .await;
    let (status, start) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/start",
            Some(&token),
            Some(json!({ "passkeyId": passkeys[0]["id"] })),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let options: RequestChallengeResponse =
        serde_json::from_value(start["options"].clone()).unwrap();
    let credential = pk
        .do_authentication(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/finish",
            Some(&other),
            Some(json!({
                "ceremonyId": start["ceremonyId"],
                "credential": credential,
                "prfFirst": stand_in_prf(1),
            })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn changing_wrappers_needs_a_fresh_passkey_device() {
    let v = vault_harness(false).await;
    let token = v.harness.setup(&mut authenticator()).await;
    v.unlock_with_recovery(&token).await;
    // A token device, even one with admin, is never fresh.
    let store = v.harness.state.store.clone();
    let events = v.harness.state.events.clone();
    let admin = yarvis_server::devices::add_token_device(
        &store,
        &events,
        "cli",
        &yarvis_server::auth::Scope::ALL,
        None,
    )
    .await
    .unwrap()
    .token;
    let (status, body) = v
        .harness
        .call("DELETE", "/api/vault/wrappers/recovery", Some(&admin), None)
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    assert_eq!(body["error"], "reauth_required");
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/start",
            Some(&admin),
            Some(json!({ "passkeyId": "x" })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);

    // It can still unlock and lock: a CLI token is how to recover when every
    // passkey is lost.
    v.harness
        .call("POST", "/api/vault/lock", Some(&admin), None)
        .await;
    let (status, _) = v.unlock_with_recovery(&admin).await;
    assert_eq!(status, StatusCode::OK);
}

#[tokio::test]
async fn removing_a_wrapper_revokes_it_and_the_last_one_stays() {
    let v = vault_harness(false).await;
    let mut pk = authenticator();
    let token = v.harness.setup(&mut pk).await;
    v.unlock_with_recovery(&token).await;
    let (_, passkeys) = v
        .harness
        .call("GET", "/api/passkeys", Some(&token), None)
        .await;
    let (_, _, body) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/wrappers/passkey",
            &token,
            Some(json!({ "passkeyId": passkeys[0]["id"] })),
            Some(&stand_in_prf(7)),
        )
        .await;
    let wrapper_id = body["wrapperId"].as_str().unwrap().to_string();

    let (status, _) = v
        .harness
        .call(
            "DELETE",
            &format!("/api/vault/wrappers/{wrapper_id}"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::NO_CONTENT);
    let (status, _) = v
        .harness
        .call("DELETE", "/api/vault/wrappers/recovery", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "the last wrapper");
    let (status, _) = v
        .harness
        .call("DELETE", "/api/vault/wrappers/nope", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);

    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    let (status, _) = v
        .harness
        .call("POST", "/api/vault/unlock/start", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "no passkey can unlock now");
}

/// The work-laptop setting: the signing key stays in 1Password, so the server
/// must not make a key, open a socket, or serve the agent's route.
#[tokio::test]
async fn with_the_agent_off_nothing_signs() {
    let v = vault_harness(false).await;
    let token = v.harness.setup(&mut authenticator()).await;
    let (status, _) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK);

    assert_eq!(ssh_agent::socket_path(&v.harness.state), None);
    assert!(!v.harness.state.ssh_agent.is_running());
    assert!(
        v.harness
            .state
            .vault
            .secret(SIGNING_KEY_SECRET)
            .unwrap()
            .is_none(),
        "a signing key was made"
    );
    let sockets: Vec<_> = std::fs::read_dir(v.dir.path())
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().unwrap().is_socket())
        .collect();
    assert!(sockets.is_empty(), "{sockets:?}");
    let (status, _) = v
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn with_the_agent_on_it_runs_only_while_unlocked() {
    let v = vault_harness(true).await;
    let token = v.harness.setup(&mut authenticator()).await;
    let socket = ssh_agent::socket_path(&v.harness.state).unwrap();
    assert_eq!(socket, v.dir.path().join("ssh-agent.sock"));

    let (status, body) = v
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(body, json!({ "enabled": true }));
    assert!(!socket.exists());

    v.unlock_with_recovery(&token).await;
    let (_, body) = v
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&token), None)
        .await;
    assert!(
        body["publicKey"]
            .as_str()
            .unwrap()
            .starts_with("ssh-ed25519 ")
    );
    assert_eq!(body["socketPath"], socket.display().to_string());
    let mode = std::fs::metadata(&socket).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode, 0o600);

    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert!(!socket.exists(), "the socket outlived the lock");
    let (_, body) = v
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&token), None)
        .await;
    assert_eq!(body, json!({ "enabled": true }));
}

#[tokio::test]
async fn a_live_server_sees_vault_init() {
    let mut v = vault_harness_without_a_vault(false).await;
    let token = v.harness.setup(&mut authenticator()).await;
    let (_, status) = v
        .harness
        .call("GET", "/api/vault/status", Some(&token), None)
        .await;
    assert_eq!(status, json!({ "state": "uninitialized", "wrappers": [] }));
    let (_, auth) = v.harness.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(auth["vault"], "uninitialized");
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/unlock/recovery",
            Some(&token),
            Some(json!({ "recoveryKey": B64.encode([1u8; 32]) })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    let created = Vault::init(v.dir.path(), false).unwrap();
    v.recovery_key = created.recovery_key.expose().to_string();
    assert_eq!(v.state(&token).await, "locked");
    let (status, _) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK);
}

/// The secrets matter more than signing, so an agent that can't start leaves
/// the vault unlocked.
#[tokio::test]
async fn an_agent_that_cannot_start_leaves_the_vault_unlocked() {
    let v = vault_harness(true).await;
    let token = v.harness.setup(&mut authenticator()).await;
    // A non-empty directory where the socket goes can't be removed or bound.
    let socket = ssh_agent::socket_path(&v.harness.state).unwrap();
    std::fs::create_dir_all(socket.join("in-the-way")).unwrap();

    let (status, body) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    assert_eq!(v.state(&token).await, "unlocked");
    assert_eq!(
        v.harness.state.vault.secret_backend().read_root().unwrap(),
        None
    );
    let (_, body) = v
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&token), None)
        .await;
    assert_eq!(body, json!({ "enabled": true }));
}

#[tokio::test]
async fn an_enrollment_that_fails_adds_no_wrapper() {
    let v = vault_harness(false).await;
    let mut pk = authenticator();
    let token = v.harness.setup(&mut pk).await;
    v.unlock_with_recovery(&token).await;
    let (_, passkeys) = v
        .harness
        .call("GET", "/api/passkeys", Some(&token), None)
        .await;
    let enroll = json!({ "passkeyId": passkeys[0]["id"] });

    let (_, status, body) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/wrappers/passkey",
            &token,
            Some(enroll.clone()),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "no PRF output: {body}");

    // Locked between start and finish.
    let (status, start) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/start",
            Some(&token),
            Some(enroll),
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    let options: RequestChallengeResponse =
        serde_json::from_value(start["options"].clone()).unwrap();
    let credential = pk
        .do_authentication(Url::parse(ORIGIN).unwrap(), options)
        .unwrap();
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/wrappers/passkey/finish",
            Some(&token),
            Some(json!({
                "ceremonyId": start["ceremonyId"],
                "credential": credential,
                "prfFirst": stand_in_prf(7),
            })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);

    let (_, status) = v
        .harness
        .call("GET", "/api/vault/status", Some(&token), None)
        .await;
    let kinds: Vec<_> = status["wrappers"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w["kind"].clone())
        .collect();
    assert_eq!(kinds, vec![json!("recovery")]);
}

/// `vault init` prints only the recovery key to stdout, makes a signing key
/// only with the agent on, and never replaces a vault.
#[tokio::test]
async fn the_vault_init_command() {
    let run = |agent_enabled: bool| {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("server.toml");
        std::fs::write(
            &config,
            format!(
                "[server]\ndata_dir = {:?}\n[secrets]\nbackend = \"vault\"\n[ssh_agent]\nenabled = {agent_enabled}\n",
                dir.path()
            ),
        )
        .unwrap();
        let init = move || {
            std::process::Command::new(env!("CARGO_BIN_EXE_yarvis-server"))
                .args(["--config", config.to_str().unwrap(), "vault", "init"])
                .output()
                .unwrap()
        };
        (dir, init)
    };

    let (dir, init) = run(false);
    let output = init();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let stdout = String::from_utf8(output.stdout).unwrap();
    assert_eq!(
        stdout.lines().count(),
        1,
        "only the recovery key goes to stdout"
    );
    assert!(!String::from_utf8_lossy(&output.stderr).contains("signing key"));
    let recovery = yarvis_server::vault::RecoveryKey::parse(stdout.trim()).unwrap();
    let vault = Vault::new(dir.path());
    vault.unlock_with_recovery(&recovery).unwrap();
    assert!(vault.secret(SIGNING_KEY_SECRET).unwrap().is_none());

    let before = std::fs::read(dir.path().join("vault.json")).unwrap();
    let again = init();
    assert!(!again.status.success());
    assert!(again.stdout.is_empty());
    assert_eq!(
        std::fs::read(dir.path().join("vault.json")).unwrap(),
        before
    );

    let (dir, init) = run(true);
    let output = init();
    assert!(output.status.success());
    let stderr = String::from_utf8_lossy(&output.stderr);
    let public_key = stderr
        .lines()
        .find_map(|l| {
            l.split(": ")
                .nth(1)
                .filter(|k| k.starts_with("ssh-ed25519 "))
        })
        .unwrap_or_else(|| panic!("no public key in {stderr}"))
        .to_string();
    let recovery =
        yarvis_server::vault::RecoveryKey::parse(String::from_utf8(output.stdout).unwrap().trim())
            .unwrap();
    let vault = Vault::new(dir.path());
    vault.unlock_with_recovery(&recovery).unwrap();
    let seed = vault.secret(SIGNING_KEY_SECRET).unwrap().unwrap();
    let seed: [u8; 32] = seed.as_slice().try_into().unwrap();
    assert_eq!(ssh_agent::public_key_openssh(&seed), public_key);
}

#[tokio::test]
async fn a_short_prf_output_is_refused() {
    let v = vault_harness(false).await;
    let mut pk = authenticator();
    let token = v.harness.setup(&mut pk).await;
    v.unlock_with_recovery(&token).await;
    let (_, passkeys) = v
        .harness
        .call("GET", "/api/passkeys", Some(&token), None)
        .await;
    let (_, status, body) = v
        .prf_ceremony(
            &mut pk,
            "/api/vault/wrappers/passkey",
            &token,
            Some(json!({ "passkeyId": passkeys[0]["id"] })),
            Some("AA"),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
}

#[tokio::test]
async fn removing_a_passkey_removes_its_wrapper() {
    let v = vault_harness(false).await;
    let mut laptop = authenticator();
    let token = v.harness.setup(&mut laptop).await;
    let mut key = authenticator();
    let (status, body) = v
        .harness
        .register(
            &mut key,
            "/api/passkeys/register",
            Some(&token),
            json!({ "label": "security key" }),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let key_id = body["passkeyId"].as_str().unwrap().to_string();
    v.unlock_with_recovery(&token).await;
    let (_, status, body) = v
        .prf_ceremony(
            &mut key,
            "/api/vault/wrappers/passkey",
            &token,
            Some(json!({ "passkeyId": key_id })),
            Some(&stand_in_prf(9)),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let (status, _) = v
        .harness
        .call(
            "DELETE",
            &format!("/api/passkeys/{key_id}"),
            Some(&token),
            None,
        )
        .await;
    assert_eq!(status, StatusCode::OK);
    let (_, status) = v
        .harness
        .call("GET", "/api/vault/status", Some(&token), None)
        .await;
    assert_eq!(status["wrappers"].as_array().unwrap().len(), 1, "{status}");
    assert_eq!(status["wrappers"][0]["kind"], "recovery");
}

/// Unlocks and locks raced against each other must never leave the agent
/// running on a locked vault.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lock_racing_an_unlock_never_leaves_the_agent_running() {
    let v = vault_harness(true).await;
    let token = v.harness.setup(&mut authenticator()).await;
    for _ in 0..30 {
        let unlock = v.unlock_with_recovery(&token);
        let lock = v
            .harness
            .call("POST", "/api/vault/lock", Some(&token), None);
        tokio::join!(unlock, lock);
        let unlocked = v.harness.state.vault.is_unlocked();
        assert!(
            unlocked || !v.harness.state.ssh_agent.is_running(),
            "the agent is running on a locked vault"
        );
        v.harness
            .call("POST", "/api/vault/lock", Some(&token), None)
            .await;
    }
}
