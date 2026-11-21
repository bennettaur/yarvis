//! The server's encrypted vault: the secrets blob and the git signing key,
//! encrypted at rest in `vault.json` in the data dir.
//!
//! The vault starts locked on every boot. A passkey (through its PRF output)
//! or the recovery key unwraps the vault key, and the decrypted secrets stay
//! in memory until it is locked again. Nothing is cached on disk in the clear.
//! The format and its reasoning are in `file.rs`; `spikes/vault/FINDINGS.md`
//! has the trade-offs behind it.
//!
//! While locked, the handle holds nothing but the file's path: status and
//! unlock read the file fresh, so `vault init` run on a live server is seen
//! at once.

pub mod backend;
pub mod file;
pub mod routes;

use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};

use rand::RngCore;
use tokio::sync::watch;
use zeroize::Zeroizing;

pub use self::file::{RecoveryKey, UnwrapSecret, VaultError, Wrapper, WrapperKind};
use self::file::{Secrets, Unlocked, VaultFile};
use crate::secret_store::SecretBackend;

/// The vault secret holding the secrets blob `SecretBackend` stores.
pub const SECRETS_BLOB: &str = "secrets_blob";

/// The vault secret holding the 32-byte Ed25519 seed the ssh-agent signs with.
pub const SIGNING_KEY_SECRET: &str = "ssh_signing_key_ed25519_seed";

const FILE_NAME: &str = "vault.json";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VaultState {
    /// No vault file yet.
    Uninitialized,
    Locked,
    Unlocked,
}

impl VaultState {
    pub fn as_str(self) -> &'static str {
        match self {
            VaultState::Uninitialized => "uninitialized",
            VaultState::Locked => "locked",
            VaultState::Unlocked => "unlocked",
        }
    }
}

/// What `vault init` made. The recovery key is shown to the user once.
pub struct Created {
    pub recovery_key: RecoveryKey,
    /// The signing key's OpenSSH public key, when one was generated.
    pub signing_public_key: Option<String>,
}

/// A shared handle to the vault. Cloning it shares the lock state.
#[derive(Clone)]
pub struct Vault(Arc<Inner>);

struct Inner {
    path: PathBuf,
    unlocked: Mutex<Option<Unlocked>>,
    /// `true` while unlocked, for code that waits for secrets to be readable.
    changes: watch::Sender<bool>,
}

impl Vault {
    /// A locked handle on `data_dir/vault.json`. Reads nothing yet.
    pub fn new(data_dir: &Path) -> Self {
        Self(Arc::new(Inner {
            path: data_dir.join(FILE_NAME),
            unlocked: Mutex::new(None),
            changes: watch::channel(false).0,
        }))
    }

    pub fn path(&self) -> &Path {
        &self.0.path
    }

    /// Creates the vault file with a recovery-key wrapper, and a signing key
    /// when `with_signing_key` is set. Refuses to replace an existing vault.
    pub fn init(data_dir: &Path, with_signing_key: bool) -> Result<Created, VaultError> {
        std::fs::create_dir_all(data_dir)?;
        let mut secrets = Secrets::default();
        let signing_public_key = with_signing_key.then(|| {
            let seed = random_seed();
            secrets.insert(SIGNING_KEY_SECRET, seed.to_vec());
            crate::ssh_agent::public_key_openssh(&seed)
        });
        let (unlocked, recovery_key) = VaultFile::create(secrets);
        unlocked.file.save_new(&data_dir.join(FILE_NAME))?;
        Ok(Created {
            recovery_key,
            signing_public_key,
        })
    }

    pub fn state(&self) -> Result<VaultState, VaultError> {
        if self.lock_state().is_some() {
            return Ok(VaultState::Unlocked);
        }
        Ok(if self.0.path.try_exists()? {
            VaultState::Locked
        } else {
            VaultState::Uninitialized
        })
    }

    pub fn is_unlocked(&self) -> bool {
        self.lock_state().is_some()
    }

    /// Sees `true` on every unlock and `false` on every lock.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.0.changes.subscribe()
    }

    /// The wrappers, from memory while unlocked and from the file otherwise.
    pub fn wrappers(&self) -> Result<Vec<Wrapper>, VaultError> {
        if let Some(unlocked) = self.lock_state().as_ref() {
            return Ok(unlocked.file.wrappers.clone());
        }
        Ok(self.load()?.wrappers)
    }

    pub fn unlock_with_recovery(&self, recovery: &RecoveryKey) -> Result<(), VaultError> {
        let mut state = self.lock_state();
        if state.is_some() {
            return Err(VaultError::AlreadyUnlocked);
        }
        *state = Some(self.load()?.unlock_with_recovery(recovery)?);
        drop(state);
        self.0.changes.send_replace(true);
        Ok(())
    }

    pub fn unlock_with_passkey(
        &self,
        credential_id: &str,
        prf_output: &UnwrapSecret,
    ) -> Result<(), VaultError> {
        let mut state = self.lock_state();
        if state.is_some() {
            return Err(VaultError::AlreadyUnlocked);
        }
        *state = Some(
            self.load()?
                .unlock_with_passkey(credential_id, prf_output)?,
        );
        drop(state);
        self.0.changes.send_replace(true);
        Ok(())
    }

    /// Drops the vault key and the decrypted secrets, which zeroize on drop.
    /// Returns whether it was unlocked.
    pub fn lock(&self) -> bool {
        let was_unlocked = self.lock_state().take().is_some();
        if was_unlocked {
            self.0.changes.send_replace(false);
        }
        was_unlocked
    }

    /// Adds a wrapper that the PRF output of one passkey opens. Needs the
    /// vault unlocked, since wrapping takes the vault key.
    pub fn add_passkey_wrapper(
        &self,
        credential_id: &str,
        prf_salt: &str,
        label: &str,
        prf_output: &UnwrapSecret,
    ) -> Result<(), VaultError> {
        self.change(|unlocked| {
            unlocked.add_passkey_wrapper(credential_id, prf_salt, label, prf_output)
        })
    }

    /// Removes a wrapper. The last one is refused, since nothing could open
    /// the vault after it.
    pub fn remove_wrapper(&self, wrapper_id: &str) -> Result<(), VaultError> {
        self.change(|unlocked| unlocked.remove_wrapper(wrapper_id))
    }

    /// One decrypted secret, or `None` when the vault has no such secret.
    pub fn secret(&self, name: &str) -> Result<Option<Zeroizing<Vec<u8>>>, VaultError> {
        let state = self.lock_state();
        let unlocked = state.as_ref().ok_or(VaultError::Locked)?;
        Ok(unlocked
            .secrets
            .get(name)
            .map(|v| Zeroizing::new(v.to_vec())))
    }

    /// Stores one secret and writes the file. A failed write leaves memory as
    /// it was, so memory and disk never disagree.
    pub fn set_secret(&self, name: &str, value: Vec<u8>) -> Result<(), VaultError> {
        let mut state = self.lock_state();
        let unlocked = state.as_mut().ok_or(VaultError::Locked)?;
        let before = unlocked.file.clone();
        let previous = unlocked.secrets.insert(name, value);
        unlocked.reseal();
        if let Err(e) = unlocked.file.save(&self.0.path) {
            unlocked.secrets.restore(name, previous);
            unlocked.file = before;
            return Err(e);
        }
        Ok(())
    }

    /// The signing key's seed, generating and storing one first if the vault
    /// has none. Only the ssh-agent calls this, so a server with the agent off
    /// never makes a key.
    pub(crate) fn signing_seed(&self) -> Result<Zeroizing<[u8; 32]>, VaultError> {
        if let Some(stored) = self.secret(SIGNING_KEY_SECRET)? {
            let seed: [u8; 32] = stored.as_slice().try_into().map_err(|_| {
                VaultError::Encoding("the stored signing key isn't 32 bytes".into())
            })?;
            return Ok(Zeroizing::new(seed));
        }
        let seed = random_seed();
        self.set_secret(SIGNING_KEY_SECRET, seed.to_vec())?;
        Ok(seed)
    }

    /// The vault as a [`SecretBackend`] holding the secrets blob.
    pub fn secret_backend(&self) -> Arc<dyn SecretBackend> {
        Arc::new(backend::VaultBackend::new(self.clone()))
    }

    /// Applies a change to the unlocked vault and writes the file, keeping the
    /// old file in memory if the write fails.
    fn change(
        &self,
        apply: impl FnOnce(&mut Unlocked) -> Result<(), VaultError>,
    ) -> Result<(), VaultError> {
        let mut state = self.lock_state();
        let unlocked = state.as_mut().ok_or(VaultError::Locked)?;
        let before = unlocked.file.clone();
        apply(unlocked)?;
        if let Err(e) = unlocked.file.save(&self.0.path) {
            unlocked.file = before;
            return Err(e);
        }
        Ok(())
    }

    fn load(&self) -> Result<VaultFile, VaultError> {
        match VaultFile::load(&self.0.path) {
            Err(VaultError::Io(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                Err(VaultError::Uninitialized)
            }
            other => other,
        }
    }

    /// Nothing panics halfway through a change, so a poisoned lock is still
    /// usable.
    fn lock_state(&self) -> MutexGuard<'_, Option<Unlocked>> {
        self.0
            .unlocked
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn random_seed() -> Zeroizing<[u8; 32]> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::rng().fill_bytes(seed.as_mut());
    seed
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn starts_locked_and_reports_its_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert_eq!(vault.state().unwrap(), VaultState::Uninitialized);
        let created = Vault::init(dir.path(), false).unwrap();
        assert!(created.signing_public_key.is_none());
        assert_eq!(vault.state().unwrap(), VaultState::Locked);
        assert!(matches!(
            vault.secret(SECRETS_BLOB),
            Err(VaultError::Locked)
        ));

        let mut changes = vault.subscribe();
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        assert_eq!(vault.state().unwrap(), VaultState::Unlocked);
        assert!(*changes.borrow_and_update());
        assert!(matches!(
            vault.unlock_with_recovery(&created.recovery_key),
            Err(VaultError::AlreadyUnlocked)
        ));
        assert!(vault.lock());
        assert!(!*changes.borrow_and_update());
        assert!(!vault.lock());
    }

    #[test]
    fn init_refuses_to_replace_a_vault() {
        let dir = tempfile::tempdir().unwrap();
        Vault::init(dir.path(), false).unwrap();
        assert!(matches!(
            Vault::init(dir.path(), false),
            Err(VaultError::AlreadyExists)
        ));
    }

    #[test]
    fn a_secret_survives_lock_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false).unwrap();
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        vault.set_secret("x", b"value".to_vec()).unwrap();
        vault.lock();

        let fresh = Vault::new(dir.path());
        fresh.unlock_with_recovery(&created.recovery_key).unwrap();
        assert_eq!(fresh.secret("x").unwrap().unwrap().as_slice(), b"value");
    }

    #[test]
    fn a_failed_write_leaves_memory_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false).unwrap();
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        vault.set_secret("x", b"old".to_vec()).unwrap();

        // A directory where the temp file goes makes the write fail.
        std::fs::create_dir(vault.path().with_extension("json.tmp")).unwrap();
        assert!(vault.set_secret("x", b"new".to_vec()).is_err());
        assert_eq!(vault.secret("x").unwrap().unwrap().as_slice(), b"old");
    }

    #[test]
    fn the_signing_key_is_made_once_and_kept() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false).unwrap();
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        assert!(vault.secret(SIGNING_KEY_SECRET).unwrap().is_none());
        let first = vault.signing_seed().unwrap();
        assert_eq!(*vault.signing_seed().unwrap(), *first);
    }

    #[test]
    fn init_with_a_signing_key_stores_it() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), true).unwrap();
        let public = created.signing_public_key.unwrap();
        assert!(public.starts_with("ssh-ed25519 "), "{public}");
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        let seed = vault.secret(SIGNING_KEY_SECRET).unwrap().unwrap();
        let seed: [u8; 32] = seed.as_slice().try_into().unwrap();
        assert_eq!(crate::ssh_agent::public_key_openssh(&seed), public);
    }
}
