//! The vault routes: unlocking with the vault passphrase or the recovery key,
//! locking, changing the passphrase and the recovery key, events, and the
//! ssh-agent switch.

mod common;

use std::os::unix::fs::{FileTypeExt, PermissionsExt};

use axum::http::StatusCode;
use common::{Harness, cli_config, new_schema, server_command, until};
use serde_json::{Value, json};
use tempfile::TempDir;
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::secret_store::SecretError;
use yarvis_server::ssh_agent;
use yarvis_server::vault::{SIGNING_KEY_SECRET, Vault};

/// The vault's own passphrase, not the sign-in one.
const VAULT_PASSPHRASE: &str = "the vault's own passphrase";

struct VaultHarness {
    harness: Harness,
    dir: TempDir,
    recovery_key: String,
}

async fn vault_harness(agent_enabled: bool) -> VaultHarness {
    let v = vault_harness_without_a_vault(agent_enabled).await;
    let created = Vault::init(v.dir.path(), agent_enabled, VAULT_PASSPHRASE).unwrap();
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
    config.secrets.backend = Some(SecretBackendKind::Vault);
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
}

#[tokio::test]
async fn every_vault_route_is_404_without_the_vault_backend() {
    let harness = Harness::new().await;
    let token = harness.setup().await;
    for (method, path) in [
        ("GET", "/api/vault/status"),
        ("POST", "/api/vault/unlock/recovery"),
        ("POST", "/api/vault/lock"),
        ("POST", "/api/vault/recovery-key"),
        ("GET", "/api/vault/ssh-agent"),
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
    let token = v.harness.setup().await;
    let backend = v.harness.state.vault.secret_backend();

    assert_eq!(v.state(&token).await, "locked");
    let (_, auth) = v.harness.call("GET", "/api/auth/status", None, None).await;
    assert_eq!(auth["vault"], "locked");
    assert!(matches!(backend.read_root(), Err(SecretError::Locked)));

    let wrong = yarvis_server::vault::RecoveryKey::generate()
        .expose()
        .to_string();
    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/unlock/recovery",
            Some(&token),
            Some(json!({ "recoveryKey": wrong })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
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
    let token = v.harness.setup().await;
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
async fn with_the_agent_off_nothing_signs() {
    let v = vault_harness(false).await;
    let token = v.harness.setup().await;
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
    let token = v.harness.setup().await;
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
async fn socket_dir_gets_the_agent_socket() {
    let dir = tempfile::tempdir().unwrap();
    let data_dir = dir.path().join("data");
    let socket_dir = dir.path().join("sockets");
    std::fs::create_dir_all(&data_dir).unwrap();
    let mut config = Config::default();
    config.server.data_dir = data_dir.clone();
    config.server.socket_dir = Some(socket_dir.clone());
    config.secrets.backend = Some(SecretBackendKind::Vault);
    config.ssh_agent.enabled = true;
    config.validate().unwrap();
    let created = Vault::init(&data_dir, true, VAULT_PASSPHRASE).unwrap();
    let v = VaultHarness {
        harness: Harness::with_config(config).await,
        dir,
        recovery_key: created.recovery_key.expose().to_string(),
    };
    let token = v.harness.setup().await;
    let socket = ssh_agent::socket_path(&v.harness.state).unwrap();
    assert_eq!(socket, socket_dir.join("ssh-agent.sock"));

    v.unlock_with_recovery(&token).await;
    assert!(v.harness.state.ssh_agent.is_running());
    assert!(
        std::fs::symlink_metadata(&socket)
            .unwrap()
            .file_type()
            .is_socket()
    );
    let mode = std::fs::metadata(socket.parent().unwrap())
        .unwrap()
        .permissions()
        .mode();
    assert_eq!(mode & 0o777, 0o700);

    v.harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert!(!socket.exists(), "the socket outlived the lock");
}

#[tokio::test]
async fn a_live_server_sees_vault_init() {
    let mut v = vault_harness_without_a_vault(false).await;
    let token = v.harness.setup().await;
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
            Some(json!({ "recoveryKey": yarvis_server::vault::RecoveryKey::generate().expose() })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT, "{body}");

    let created = Vault::init(v.dir.path(), false, VAULT_PASSPHRASE).unwrap();
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
    let token = v.harness.setup().await;
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
async fn the_vault_init_command() {
    let schema = new_schema().await;
    let run = |agent_enabled: bool| {
        let dir = tempfile::tempdir().unwrap();
        let config = dir.path().join("server.toml");
        std::fs::write(
            &config,
            format!(
                "{}[secrets]\nbackend = \"vault\"\n[ssh_agent]\nenabled = {agent_enabled}\n",
                cli_config(dir.path(), &schema)
            ),
        )
        .unwrap();
        let init = move || {
            use std::io::Write;
            let mut child = server_command()
                .args([
                    "--config",
                    config.to_str().unwrap(),
                    "vault",
                    "init",
                    "--passphrase-stdin",
                ])
                .stdin(std::process::Stdio::piped())
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            writeln!(stdin, "{VAULT_PASSPHRASE}").unwrap();
            drop(stdin);
            child.wait_with_output().unwrap()
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
    vault.unlock_with_passphrase(VAULT_PASSPHRASE).unwrap();
    assert!(vault.secret(SIGNING_KEY_SECRET).unwrap().is_none());
    vault.lock();
    vault.unlock_with_recovery(&recovery).unwrap();

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

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn a_lock_racing_an_unlock_never_leaves_the_agent_running() {
    let v = vault_harness(true).await;
    let token = v.harness.setup().await;
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

/// A new recovery key needs a fresh device and replaces the old one, which
/// then opens nothing.
#[tokio::test]
async fn rotating_the_recovery_key_needs_a_fresh_device_and_retires_the_old_one() {
    let mut v = vault_harness(false).await;
    let token = v.harness.setup().await;
    let (status, body) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK, "{body}");

    let cli = yarvis_server::devices::add_token_device(
        &v.harness.state.store,
        &v.harness.state.events,
        "tauri",
        &[yarvis_server::auth::Scope::Admin],
        None,
    )
    .await
    .unwrap()
    .token;
    let proof = json!({ "currentPassphrase": VAULT_PASSPHRASE });
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/recovery-key",
            Some(&cli),
            Some(proof.clone()),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "reauth_required");

    // A fresh device alone isn't enough: it could rotate the key, then use the
    // new key to replace the passphrase.
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/recovery-key",
            Some(&token),
            Some(json!({})),
        )
        .await;
    assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/recovery-key",
            Some(&token),
            Some(json!({ "recoveryKey": yarvis_server::vault::RecoveryKey::generate().expose() })),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");

    let (status, body) = v
        .harness
        .call("POST", "/api/vault/recovery-key", Some(&token), Some(proof))
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let new_key = body["recoveryKey"].as_str().unwrap().to_string();
    assert_ne!(new_key, v.recovery_key);
    assert_eq!(
        v.harness.events("vault.recovery_key_rotated").await.len(),
        1
    );

    let (status, _) = v
        .harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    let (status, _) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::FORBIDDEN, "the old key still opened it");
    v.recovery_key = new_key;
    let (status, body) = v.unlock_with_recovery(&token).await;
    assert_eq!(status, StatusCode::OK, "{body}");
}

impl VaultHarness {
    async fn unlock_with_passphrase(&self, token: &str, passphrase: &str) -> (StatusCode, Value) {
        self.harness
            .call(
                "POST",
                "/api/vault/unlock",
                Some(token),
                Some(json!({ "passphrase": passphrase })),
            )
            .await
    }
}

/// The vault passphrase unlocks it; a wrong one is refused and makes the next
/// try wait, while the recovery key still works.
#[tokio::test]
async fn the_vault_passphrase_unlocks_and_wrong_guesses_wait() {
    let v = vault_harness(false).await;
    let token = v.harness.setup().await;
    let (status, _) = v.unlock_with_passphrase(&token, common::PASSPHRASE).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the sign-in passphrase isn't the vault's"
    );
    let (status, body) = v.unlock_with_passphrase(&token, VAULT_PASSPHRASE).await;
    assert_eq!(status, StatusCode::TOO_MANY_REQUESTS, "{body}");
    assert!(body["detail"].as_str().unwrap().contains("waits"), "{body}");

    let (status, body) = v.unlock_with_recovery(&token).await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the recovery key isn't slowed: {body}"
    );
    let (status, _) = v
        .harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK);

    // Waited out rather than slept through: a right passphrase clears it.
    until("the guess delay to pass", || async {
        v.harness.state.vault.guess_delay().is_none().then_some(())
    })
    .await;
    let (status, body) = v.unlock_with_passphrase(&token, VAULT_PASSPHRASE).await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let unlocked = v.harness.events("vault.unlocked").await;
    assert_eq!(unlocked.last().unwrap().data["via"], "passphrase");
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
    assert_eq!(kinds, [json!("passphrase"), json!("recovery")]);
}

/// A new vault passphrase needs a fresh device and the current passphrase or
/// the recovery key, and the old one then opens nothing.
#[tokio::test]
async fn changing_the_vault_passphrase_needs_proof_and_a_fresh_device() {
    let v = vault_harness(false).await;
    let token = v.harness.setup().await;
    let (status, _) = v.unlock_with_passphrase(&token, VAULT_PASSPHRASE).await;
    assert_eq!(status, StatusCode::OK);
    let change = |proof: Value| {
        let mut body = json!({ "newPassphrase": "a second vault passphrase" });
        body.as_object_mut()
            .unwrap()
            .extend(proof.as_object().unwrap().clone());
        body
    };

    let cli = yarvis_server::devices::add_token_device(
        &v.harness.state.store,
        &v.harness.state.events,
        "tauri",
        &[yarvis_server::auth::Scope::Admin],
        None,
    )
    .await
    .unwrap()
    .token;
    let proof = json!({ "currentPassphrase": VAULT_PASSPHRASE });
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/passphrase",
            Some(&cli),
            Some(change(proof.clone())),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN, "{body}");
    assert_eq!(body["error"], "reauth_required");

    let (status, _) = v
        .harness
        .call(
            "POST",
            "/api/vault/passphrase",
            Some(&token),
            Some(change(
                json!({ "currentPassphrase": "not the vault's passphrase" }),
            )),
        )
        .await;
    assert_eq!(status, StatusCode::FORBIDDEN);
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/passphrase",
            Some(&token),
            Some(json!({ "recoveryKey": v.recovery_key, "newPassphrase": common::PASSPHRASE })),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::BAD_REQUEST,
        "the sign-in passphrase can't be the vault's: {body}"
    );
    assert!(
        v.harness.state.vault.guess_delay().is_some(),
        "so the recovery key below is checked during the wait"
    );
    let (status, body) = v
        .harness
        .call(
            "POST",
            "/api/vault/passphrase",
            Some(&token),
            Some(change(json!({ "recoveryKey": v.recovery_key }))),
        )
        .await;
    assert_eq!(
        status,
        StatusCode::OK,
        "the recovery key proves it too: {body}"
    );
    assert_eq!(v.harness.events("vault.passphrase_changed").await.len(), 1);

    let (status, _) = v
        .harness
        .call("POST", "/api/vault/lock", Some(&token), None)
        .await;
    assert_eq!(status, StatusCode::OK);
    until("the guess delay to pass", || async {
        v.harness.state.vault.guess_delay().is_none().then_some(())
    })
    .await;
    let (status, _) = v.unlock_with_passphrase(&token, VAULT_PASSPHRASE).await;
    assert_eq!(
        status,
        StatusCode::FORBIDDEN,
        "the old passphrase still opened it"
    );
    until("the guess delay to pass", || async {
        v.harness.state.vault.guess_delay().is_none().then_some(())
    })
    .await;
    let (status, body) = v
        .unlock_with_passphrase(&token, "a second vault passphrase")
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
}
