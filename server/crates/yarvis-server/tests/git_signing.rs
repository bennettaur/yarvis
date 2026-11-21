//! Signs real git commits through the server's ssh-agent, answering each
//! signature on the approvals route. Needs `git` and `ssh-keygen` on PATH.
//! The key is a fresh random one made by `Vault::init`; no real key and no
//! `~/.ssh` is touched.

mod common;

use axum::http::StatusCode;
use common::git::Repo;
use common::{Harness, authenticator, until};
use serde_json::{Value, json};
use tempfile::TempDir;
use yarvis_server::config::{Config, SecretBackendKind};
use yarvis_server::ssh_agent;
use yarvis_server::vault::Vault;

struct Signer {
    harness: Harness,
    /// Holds the data dir and repo until the test ends.
    _dir: TempDir,
    public_key: String,
    token: String,
    repo: Repo,
}

/// A server with the vault and the agent on, unlocked, and a repo set up to
/// sign through it.
async fn signer() -> Signer {
    let dir = tempfile::tempdir().unwrap();
    let mut config = Config::default();
    config.server.data_dir = dir.path().to_path_buf();
    config.secrets.backend = SecretBackendKind::Vault;
    config.ssh_agent.enabled = true;
    let created = Vault::init(dir.path(), true).unwrap();
    let harness = Harness::with_config(config).await;
    let token = harness.setup(&mut authenticator()).await;
    let (status, body) = harness
        .call(
            "POST",
            "/api/vault/unlock/recovery",
            Some(&token),
            Some(json!({ "recoveryKey": created.recovery_key.expose() })),
        )
        .await;
    assert_eq!(status, StatusCode::OK, "{body}");
    let socket = ssh_agent::socket_path(&harness.state).unwrap();
    let public_key = created.signing_public_key.unwrap();
    let repo = Repo::new(dir.path(), &socket, &public_key).await;
    Signer {
        harness,
        _dir: dir,
        public_key,
        token,
        repo,
    }
}

impl Signer {
    /// Waits for the agent's approval request to show up on the route.
    async fn pending_signature(&self) -> Value {
        until("a signature approval", || async {
            let (_, list) = self
                .harness
                .call("GET", "/api/approvals", Some(&self.token), None)
                .await;
            list.as_array().and_then(|l| l.first().cloned())
        })
        .await
    }

    async fn answer(&self, id: &str, approve: bool) {
        let (status, body) = self
            .harness
            .call(
                "POST",
                &format!("/api/approvals/{id}"),
                Some(&self.token),
                Some(json!({ "approve": approve })),
            )
            .await;
        assert_eq!(status, StatusCode::OK, "{body}");
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_approved_signature_makes_a_commit_that_verifies() {
    let s = signer().await;
    let commit = tokio::spawn({
        let repo = s.repo.clone();
        async move {
            repo.git(&["commit", "-q", "--allow-empty", "-S", "-m", "approved"])
                .await
        }
    });
    let pending = s.pending_signature().await;
    assert_eq!(pending["kind"], ssh_agent::APPROVAL_KIND);
    let (_, agent) = s
        .harness
        .call("GET", "/api/vault/ssh-agent", Some(&s.token), None)
        .await;
    // The approver is shown the key that will sign.
    assert_eq!(agent["publicKey"], s.public_key.as_str());
    let fingerprint = ssh_key::PublicKey::from_openssh(&s.public_key)
        .unwrap()
        .fingerprint(ssh_key::HashAlg::Sha256)
        .to_string();
    let summary = pending["summary"].as_str().unwrap();
    assert!(summary.contains(&fingerprint), "{summary}");
    assert_eq!(pending["data"]["keyFingerprint"], fingerprint.as_str());
    s.answer(pending["id"].as_str().unwrap(), true).await;

    let out = commit.await.unwrap();
    assert!(
        out.status.success(),
        "commit failed: {}",
        String::from_utf8_lossy(&out.stderr)
    );
    let out = s.repo.git(&["verify-commit", "HEAD"]).await;
    let stderr = String::from_utf8_lossy(&out.stderr);
    assert!(out.status.success(), "verify failed: {stderr}");
    assert!(stderr.contains("Good \"git\" signature"), "{stderr}");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_denied_signature_fails_the_commit() {
    let s = signer().await;
    let commit = tokio::spawn({
        let repo = s.repo.clone();
        async move {
            repo.git(&["commit", "-q", "--allow-empty", "-S", "-m", "denied"])
                .await
        }
    });
    let pending = s.pending_signature().await;
    s.answer(pending["id"].as_str().unwrap(), false).await;

    let out = commit.await.unwrap();
    assert!(!out.status.success(), "the denied commit was made");
    let log = s.repo.git(&["log", "--format=%s"]).await;
    assert!(String::from_utf8_lossy(&log.stdout).trim().is_empty());
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn locking_while_a_signature_waits_refuses_it() {
    let s = signer().await;
    let commit = tokio::spawn({
        let repo = s.repo.clone();
        async move {
            repo.git(&["commit", "-q", "--allow-empty", "-S", "-m", "locked"])
                .await
        }
    });
    let pending = s.pending_signature().await;
    s.harness
        .call("POST", "/api/vault/lock", Some(&s.token), None)
        .await;

    let out = commit.await.unwrap();
    assert!(!out.status.success(), "a commit was signed after the lock");
    // The approval is settled as abandoned, so a late "yes" does nothing.
    let id = pending["id"].as_str().unwrap().to_string();
    until("the approval to settle", || async {
        let (_, list) = s
            .harness
            .call("GET", "/api/approvals", Some(&s.token), None)
            .await;
        list.as_array().unwrap().is_empty().then_some(())
    })
    .await;
    let (status, _) = s
        .harness
        .call(
            "POST",
            &format!("/api/approvals/{id}"),
            Some(&s.token),
            Some(json!({ "approve": true })),
        )
        .await;
    assert_eq!(status, StatusCode::CONFLICT);
    let answered: Vec<_> = s
        .harness
        .events("approval.answered")
        .await
        .into_iter()
        .filter(|e| e.data["id"] == id.as_str())
        .collect();
    assert_eq!(answered.len(), 1);
    assert_eq!(answered[0].data["approve"], false);
    assert_eq!(answered[0].data["reason"], "abandoned");
}
