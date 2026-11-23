//! The server's encrypted vault: the secrets blob and the git signing key,
//! encrypted at rest in `vault.json` in the data dir.
//!
//! The vault starts locked on every boot. Its own passphrase or the recovery
//! key unwraps the vault key, and the decrypted secrets stay
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
use std::time::{Duration, Instant};

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

/// The longest wait after a wrong vault passphrase.
const MAX_GUESS_DELAY: Duration = Duration::from_secs(300);

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

/// Wrong vault passphrases so far, and when the next try is allowed. Each wrong
/// one doubles the wait (1 s, 2 s, 4 s, up to 5 minutes), and a right one
/// clears it. A wait only slows guessing: unlike a lockout it can't keep the
/// owner out for long, and only an admin device can make it grow, since the
/// unlock route needs one. The recovery key isn't slowed: it can't be guessed.
#[derive(Default)]
struct Guesses {
    wrong: u32,
    next_try: Option<Instant>,
    /// One passphrase at a time: requests sent together would otherwise all
    /// pass the wait before any of them recorded a wrong guess.
    in_progress: bool,
}

/// The right to try one passphrase, from [`Vault::begin_guess`]. Dropping it
/// without [`GuessTurn::record`] (an I/O error, say) counts as no guess.
struct GuessTurn<'a>(&'a Vault);

impl GuessTurn<'_> {
    fn record(self, right: bool) {
        self.0.record_guess(right);
    }
}

impl Drop for GuessTurn<'_> {
    fn drop(&mut self) {
        lock(&self.0.0.guesses).in_progress = false;
    }
}

/// How a passphrase change proves it is the owner's.
pub enum Proof<'a> {
    Passphrase(&'a str),
    Recovery(&'a RecoveryKey),
}

/// A shared handle to the vault. Cloning it shares the lock state.
#[derive(Clone)]
pub struct Vault(Arc<Inner>);

struct Inner {
    path: PathBuf,
    unlocked: Mutex<Option<Unlocked>>,
    guesses: Mutex<Guesses>,
    /// `true` while unlocked, for code that waits for secrets to be readable.
    unlocked_signal: watch::Sender<bool>,
}

impl Vault {
    /// A locked handle on `data_dir/vault.json`. Reads nothing yet.
    pub fn new(data_dir: &Path) -> Self {
        Self(Arc::new(Inner {
            path: data_dir.join(FILE_NAME),
            unlocked: Mutex::new(None),
            guesses: Mutex::default(),
            unlocked_signal: watch::channel(false).0,
        }))
    }

    pub fn path(&self) -> &Path {
        &self.0.path
    }

    /// Creates the vault file with a passphrase wrapper and a recovery-key
    /// wrapper, and a signing key when `with_signing_key` is set. Refuses to
    /// replace an existing vault.
    pub fn init(
        data_dir: &Path,
        with_signing_key: bool,
        passphrase: &str,
    ) -> Result<Created, VaultError> {
        std::fs::create_dir_all(data_dir)?;
        let mut secrets = Secrets::default();
        let signing_public_key = with_signing_key.then(|| {
            let seed = random_seed();
            secrets.insert(SIGNING_KEY_SECRET, seed.to_vec());
            crate::ssh_agent::public_key_openssh(&seed)
        });
        let (unlocked, recovery_key) = VaultFile::create(secrets, passphrase)?;
        unlocked.file.save_new(&data_dir.join(FILE_NAME))?;
        Ok(Created {
            recovery_key,
            signing_public_key,
        })
    }

    pub fn state(&self) -> Result<VaultState, VaultError> {
        if self.is_unlocked() {
            return Ok(VaultState::Unlocked);
        }
        Ok(if self.0.path.try_exists()? {
            VaultState::Locked
        } else {
            VaultState::Uninitialized
        })
    }

    /// Reads the signal rather than the lock, so an open route like
    /// `/api/auth/status` never waits on a slow change holding it.
    pub fn is_unlocked(&self) -> bool {
        *self.0.unlocked_signal.borrow()
    }

    /// Sees `true` on every unlock and `false` on every lock.
    pub fn subscribe(&self) -> watch::Receiver<bool> {
        self.0.unlocked_signal.subscribe()
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
        self.0.unlocked_signal.send_replace(true);
        Ok(())
    }

    /// How long until another passphrase may be tried, after wrong ones.
    pub fn guess_delay(&self) -> Option<Duration> {
        let guesses = lock(&self.0.guesses);
        guesses
            .next_try
            .and_then(|at| at.checked_duration_since(Instant::now()))
    }

    /// Claims the next passphrase try, or says how long to wait for it.
    fn begin_guess(&self) -> Result<GuessTurn<'_>, VaultError> {
        let mut guesses = lock(&self.0.guesses);
        if let Some(left) = guesses
            .next_try
            .and_then(|at| at.checked_duration_since(Instant::now()))
        {
            return Err(VaultError::TooSoon(left));
        }
        if guesses.in_progress {
            return Err(VaultError::TooSoon(Duration::from_secs(1)));
        }
        guesses.in_progress = true;
        Ok(GuessTurn(self))
    }

    fn record_guess(&self, right: bool) {
        let mut guesses = lock(&self.0.guesses);
        if right {
            *guesses = Guesses::default();
            return;
        }
        guesses.wrong += 1;
        // The shift stops at 9 (512 s, past the cap) so it can't overflow.
        let wait = Duration::from_secs(1u64 << (guesses.wrong - 1).min(9)).min(MAX_GUESS_DELAY);
        guesses.next_try = Some(Instant::now() + wait);
    }

    /// Unlocks with the vault passphrase. Slow (the passphrase is stretched),
    /// so call it off the async workers. A wrong passphrase makes the next
    /// try wait, and a try during the wait is [`VaultError::TooSoon`].
    pub fn unlock_with_passphrase(&self, passphrase: &str) -> Result<(), VaultError> {
        if self.is_unlocked() {
            return Err(VaultError::AlreadyUnlocked);
        }
        let turn = self.begin_guess()?;
        // Stretched without holding the lock, which `secret()` also takes.
        let result = self.load()?.unlock_with_passphrase(passphrase);
        match &result {
            Ok(_) => turn.record(true),
            Err(VaultError::WrongKey) => turn.record(false),
            Err(_) => {}
        }
        let unlocked = result?;
        let mut state = self.lock_state();
        if state.is_some() {
            return Err(VaultError::AlreadyUnlocked);
        }
        *state = Some(unlocked);
        drop(state);
        self.0.unlocked_signal.send_replace(true);
        Ok(())
    }

    /// Replaces the vault passphrase, after checking the current one or the
    /// recovery key. Needs the vault unlocked, since wrapping takes the vault
    /// key. Slow: call it off the async workers.
    pub fn change_passphrase(
        &self,
        proof: Proof<'_>,
        new_passphrase: &str,
    ) -> Result<(), VaultError> {
        self.change_with_proof(proof, |unlocked| unlocked.set_passphrase(new_passphrase))
    }

    /// Applies a change once `proof` opens the vault. A passphrase proof is a
    /// guess like an unlock's and waits the same way.
    fn change_with_proof(
        &self,
        proof: Proof<'_>,
        apply: impl FnOnce(&mut Unlocked) -> Result<(), VaultError>,
    ) -> Result<(), VaultError> {
        let turn = match proof {
            Proof::Passphrase(_) => Some(self.begin_guess()?),
            Proof::Recovery(_) => None,
        };
        self.change(|unlocked| {
            let proven = match proof {
                Proof::Passphrase(current) => {
                    let right = unlocked.opens_with_passphrase(current);
                    if let Some(turn) = turn {
                        turn.record(right);
                    }
                    right
                }
                Proof::Recovery(recovery) => unlocked.opens_with_recovery(recovery),
            };
            if !proven {
                return Err(VaultError::WrongKey);
            }
            apply(unlocked)
        })
    }

    /// Drops the vault key and the decrypted secrets, which zeroize on drop.
    /// Returns whether it was unlocked.
    pub fn lock(&self) -> bool {
        let was_unlocked = self.lock_state().take().is_some();
        if was_unlocked {
            self.0.unlocked_signal.send_replace(false);
        }
        was_unlocked
    }

    /// Replaces the recovery key, after checking the vault passphrase or the
    /// current key. The old key stops opening the vault once the file is
    /// written. Without the proof, a stolen fresh device could rotate the key
    /// and then use the new one to replace the passphrase.
    pub fn rotate_recovery_key(&self, proof: Proof<'_>) -> Result<RecoveryKey, VaultError> {
        let mut new_key = None;
        self.change_with_proof(proof, |unlocked| {
            new_key = Some(unlocked.rotate_recovery_key());
            Ok(())
        })?;
        Ok(new_key.expect("set by the change"))
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

    fn lock_state(&self) -> MutexGuard<'_, Option<Unlocked>> {
        lock(&self.0.unlocked)
    }
}

/// Nothing panics halfway through a change, so a poisoned lock is still
/// usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

fn random_seed() -> Zeroizing<[u8; 32]> {
    let mut seed = Zeroizing::new([0u8; 32]);
    rand::rng().fill_bytes(seed.as_mut());
    seed
}

#[cfg(test)]
mod tests {
    use super::*;

    const TEST_PASSPHRASE: &str = "a vault passphrase";

    #[test]
    fn a_wrong_passphrase_makes_the_next_try_wait_longer_each_time() {
        let dir = tempfile::tempdir().unwrap();
        Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
        let vault = Vault::new(dir.path());
        assert_eq!(vault.guess_delay(), None);
        assert!(matches!(
            vault.unlock_with_passphrase("not it"),
            Err(VaultError::WrongKey)
        ));
        let first = vault.guess_delay().unwrap();
        assert!(first <= Duration::from_secs(1), "{first:?}");
        assert!(
            matches!(
                vault.unlock_with_passphrase(TEST_PASSPHRASE),
                Err(VaultError::TooSoon(_))
            ),
            "even the right passphrase waits"
        );
        vault.record_guess(false);
        assert!(vault.guess_delay().unwrap() > Duration::from_secs(1));
        // Skip the wait rather than sleep through it.
        lock(&vault.0.guesses).next_try = None;
        vault.unlock_with_passphrase(TEST_PASSPHRASE).unwrap();
        assert_eq!(vault.guess_delay(), None, "a right passphrase clears it");
    }

    #[test]
    fn only_one_passphrase_is_tried_at_a_time() {
        let dir = tempfile::tempdir().unwrap();
        Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
        let vault = Vault::new(dir.path());
        let turn = vault.begin_guess().unwrap();
        assert!(matches!(
            vault.unlock_with_passphrase(TEST_PASSPHRASE),
            Err(VaultError::TooSoon(_))
        ));
        drop(turn);
        vault.unlock_with_passphrase(TEST_PASSPHRASE).unwrap();
    }

    #[test]
    fn the_passphrase_changes_with_the_current_one_or_the_recovery_key() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
        let vault = Vault::new(dir.path());
        assert!(matches!(
            vault.change_passphrase(Proof::Passphrase(TEST_PASSPHRASE), "x"),
            Err(VaultError::Locked)
        ));
        vault.unlock_with_passphrase(TEST_PASSPHRASE).unwrap();
        assert!(matches!(
            vault.change_passphrase(Proof::Passphrase("wrong"), "second passphrase"),
            Err(VaultError::WrongKey)
        ));
        assert!(
            matches!(
                vault.change_passphrase(Proof::Passphrase(TEST_PASSPHRASE), "second passphrase"),
                Err(VaultError::TooSoon(_))
            ),
            "a wrong passphrase here waits like an unlock's"
        );
        lock(&vault.0.guesses).next_try = None;
        vault
            .change_passphrase(Proof::Passphrase(TEST_PASSPHRASE), "second passphrase")
            .unwrap();
        vault
            .change_passphrase(Proof::Recovery(&created.recovery_key), "third passphrase")
            .unwrap();
        vault.lock();
        let fresh = Vault::new(dir.path());
        assert!(fresh.unlock_with_passphrase("second passphrase").is_err());
        lock(&fresh.0.guesses).next_try = None;
        fresh.unlock_with_passphrase("third passphrase").unwrap();
    }

    #[test]
    fn starts_locked_and_reports_its_state() {
        let dir = tempfile::tempdir().unwrap();
        let vault = Vault::new(dir.path());
        assert_eq!(vault.state().unwrap(), VaultState::Uninitialized);
        let created = Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
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
        Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
        assert!(matches!(
            Vault::init(dir.path(), false, TEST_PASSPHRASE),
            Err(VaultError::AlreadyExists)
        ));
    }

    #[test]
    fn a_secret_survives_lock_and_reload() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
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
        let created = Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
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
        let created = Vault::init(dir.path(), false, TEST_PASSPHRASE).unwrap();
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        assert!(vault.secret(SIGNING_KEY_SECRET).unwrap().is_none());
        let first = vault.signing_seed().unwrap();
        assert_eq!(*vault.signing_seed().unwrap(), *first);

        // It is on disk too, so a restart signs with the same key.
        vault.lock();
        let restarted = Vault::new(dir.path());
        restarted
            .unlock_with_recovery(&created.recovery_key)
            .unwrap();
        assert_eq!(*restarted.signing_seed().unwrap(), *first);
    }

    #[test]
    fn init_with_a_signing_key_stores_it() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), true, TEST_PASSPHRASE).unwrap();
        let public = created.signing_public_key.unwrap();
        assert!(public.starts_with("ssh-ed25519 "), "{public}");
        let vault = Vault::new(dir.path());
        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        let seed = vault.secret(SIGNING_KEY_SECRET).unwrap().unwrap();
        let seed: [u8; 32] = seed.as_slice().try_into().unwrap();
        assert_eq!(crate::ssh_agent::public_key_openssh(&seed), public);
    }
}
