//! A throwaway git repo for the signing tests. Every git call runs with an
//! isolated HOME and no global or system config, so the user's own signing
//! setup (for example 1Password's op-ssh-sign) is never used.

use std::path::{Path, PathBuf};
use std::process::Output;

use tokio::process::Command;

pub async fn git(repo: &Path, home: &Path, sock: &Path, args: &[&str]) -> Output {
    Command::new("git")
        .args(args)
        .current_dir(repo)
        .env_clear()
        .env("PATH", std::env::var("PATH").unwrap())
        .env("TMPDIR", std::env::temp_dir())
        .env("HOME", home)
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("SSH_AUTH_SOCK", sock)
        .output()
        .await
        .expect("git runs")
}

/// A temp git repo configured to sign with `pubkey` (OpenSSH format) through
/// the agent at `sock`.
#[derive(Clone)]
pub struct Repo {
    pub repo: PathBuf,
    pub home: PathBuf,
    pub sock: PathBuf,
}

impl Repo {
    pub async fn new(root: &Path, sock: &Path, pubkey: &str) -> Repo {
        let repo = root.join("repo");
        let home = root.join("home");
        std::fs::create_dir_all(&repo).unwrap();
        std::fs::create_dir_all(&home).unwrap();
        let allowed = root.join("allowed_signers");
        std::fs::write(
            &allowed,
            format!("signer@example.invalid namespaces=\"git\" {pubkey}\n"),
        )
        .unwrap();

        let r = Repo {
            repo,
            home,
            sock: sock.to_owned(),
        };
        let signingkey = format!("key::{pubkey}");
        let allowed = allowed.to_str().unwrap().to_owned();
        for args in [
            vec!["init", "-q"],
            vec!["config", "user.name", "Yarvis Test"],
            vec!["config", "user.email", "signer@example.invalid"],
            vec!["config", "gpg.format", "ssh"],
            vec!["config", "gpg.ssh.program", "ssh-keygen"],
            vec!["config", "user.signingkey", &signingkey],
            vec!["config", "gpg.ssh.allowedSignersFile", &allowed],
        ] {
            let out = r.git(&args).await;
            assert!(
                out.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&out.stderr)
            );
        }
        r
    }

    pub async fn git(&self, args: &[&str]) -> Output {
        git(&self.repo, &self.home, &self.sock, args).await
    }
}
