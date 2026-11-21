//! The server's one account: a passphrase, a TOTP secret, and backup codes.
//!
//! Sign-in takes the passphrase and a code from an authenticator app (or one
//! backup code). The passphrase is stored as an Argon2id hash. The TOTP secret
//! has to be stored as it is, since the server computes codes from it, so
//! whoever can read the database can make codes; the passphrase hash still
//! stands between them and a sign-in. Backup codes have 50 bits of randomness
//! each, so a SHA-256 is enough to store them.
//!
//! Setup and TOTP re-enrollment are two requests. The first returns a new
//! secret and keeps it in memory as a pending enrollment; the second proves the
//! app has it by sending a code. A restart only costs the pending step.

use std::collections::{HashMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use argon2::password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::RngCore;
use rusqlite::OptionalExtension;
use zeroize::Zeroizing;

use super::new_id;
use super::setup_code::{self, CodeError, CodeHash};
use super::totp;
use crate::store::{Store, StoreError, now_ms};

/// Passphrases shorter than this are refused. Long enough that a guess per
/// sign-in attempt, under the lockout, gets nowhere.
pub const MIN_PASSPHRASE_CHARS: usize = 12;
/// Hashing is the slow part of a sign-in, so a huge input is refused first.
const MAX_PASSPHRASE_BYTES: usize = 1024;

/// Argon2id at OWASP's recommended minimum (19 MiB, 2 passes): about 50 ms
/// on a laptop, fine for a sign-in, and costly to brute-force from a stolen
/// database.
const LOGIN_MEMORY_KIB: u32 = 19 * 1024;
const LOGIN_PASSES: u32 = 2;

pub const BACKUP_CODES: usize = 10;

/// How long a pending enrollment waits for its confirming code.
const ENROLLMENT_TTL: Duration = Duration::from_secs(600);
/// Pending enrollments held at once. Setup needs the setup code and
/// re-enrollment a fresh admin device, so this only bounds memory.
const MAX_ENROLLMENTS: usize = 16;

/// Failed sign-ins, from any address, before the account locks.
const MAX_FAILURES: usize = 10;
const FAILURE_WINDOW: Duration = Duration::from_secs(15 * 60);
const LOCKOUT: Duration = Duration::from_secs(15 * 60);

#[derive(Debug, thiserror::Error)]
pub enum AccountError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("couldn't write the setup code file: {0}")]
    File(#[from] std::io::Error),
    #[error("passphrase hashing failed: {0}")]
    Hash(String),
    #[error("too many failed sign-ins")]
    Locked(Duration),
    #[error("the account no longer exists")]
    Gone,
}

impl From<rusqlite::Error> for AccountError {
    fn from(e: rusqlite::Error) -> Self {
        Self::Store(StoreError::Sqlite(e))
    }
}

/// Why a passphrase is refused before it's hashed.
pub fn check_passphrase_shape(passphrase: &str) -> Result<(), String> {
    if passphrase.chars().count() < MIN_PASSPHRASE_CHARS {
        return Err(format!(
            "use a passphrase of at least {MIN_PASSPHRASE_CHARS} characters"
        ));
    }
    if passphrase.len() > MAX_PASSPHRASE_BYTES {
        return Err(format!(
            "a passphrase is at most {MAX_PASSPHRASE_BYTES} bytes"
        ));
    }
    Ok(())
}

fn argon2(memory_kib: u32, passes: u32) -> Argon2<'static> {
    let params = Params::new(memory_kib, passes, 1, None).expect("the Argon2 parameters are valid");
    Argon2::new(Algorithm::Argon2id, Version::V0x13, params)
}

fn salt() -> SaltString {
    let mut bytes = [0u8; 16];
    rand::rng().fill_bytes(&mut bytes);
    SaltString::encode_b64(&bytes).expect("16 bytes is a valid salt")
}

/// An Argon2id PHC string for a sign-in passphrase. Slow on purpose, so run
/// it off the async workers.
pub fn hash_passphrase(passphrase: &str) -> Result<String, AccountError> {
    argon2(LOGIN_MEMORY_KIB, LOGIN_PASSES)
        .hash_password(passphrase.as_bytes(), &salt())
        .map(|hash| hash.to_string())
        .map_err(|e| AccountError::Hash(e.to_string()))
}

/// Checks a passphrase against its stored hash, with the parameters the hash
/// was made with. The final comparison is constant-time.
pub fn verify_passphrase(passphrase: &str, stored: &str) -> bool {
    let Ok(hash) = PasswordHash::new(stored) else {
        return false;
    };
    Argon2::default()
        .verify_password(passphrase.as_bytes(), &hash)
        .is_ok()
}

/// A TOTP secret waiting for its first code.
pub struct Enrollment {
    pub id: String,
    pub secret_base32: String,
    pub otpauth_uri: String,
    pub qr_svg: String,
}

enum Pending {
    Setup {
        code: CodeHash,
        passphrase_hash: String,
        device_name: String,
    },
    Reenroll {
        device_id: String,
    },
}

struct PendingEnrollment {
    at: Instant,
    secret: Zeroizing<Vec<u8>>,
    kind: Pending,
}

/// What a confirmed setup made.
pub struct SetUp {
    pub device_name: String,
    pub backup_codes: Vec<String>,
}

#[derive(Debug, PartialEq, Eq)]
pub enum SetupError {
    UnknownEnrollment,
    WrongCode,
    /// The setup code was used or replaced while this enrollment waited.
    CodeGone,
    /// An account exists already.
    Done,
}

/// The second factor a sign-in offers.
pub enum SecondFactor<'a> {
    Totp(&'a str),
    Backup(&'a str),
}

#[derive(Default)]
struct Lockout {
    failures: VecDeque<Instant>,
    until: Option<Instant>,
    /// Attempts still being checked. Each holds a place under the limit, so
    /// requests sent together can't all start before any failure counts.
    in_flight: usize,
}

/// A place under the lockout limit for one check, from
/// [`Account::begin_attempt`]. Dropped without [`Attempt::finish`] (a store
/// error, say), it counts as nothing.
struct Attempt<'a>(&'a Account);

impl Attempt<'_> {
    fn finish(self, ok: bool) {
        if ok {
            self.0.record_success();
        } else {
            self.0.record_failure();
        }
    }
}

impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        let mut lockout = lock(&self.0.0.lockout);
        lockout.in_flight = lockout.in_flight.saturating_sub(1);
    }
}

#[derive(Clone)]
pub struct Account(Arc<Inner>);

struct Inner {
    store: Store,
    setup_code_file: Mutex<Option<PathBuf>>,
    pending: Mutex<HashMap<String, PendingEnrollment>>,
    lockout: Mutex<Lockout>,
}

impl Account {
    pub fn new(store: Store) -> Self {
        Self(Arc::new(Inner {
            store,
            setup_code_file: Mutex::default(),
            pending: Mutex::default(),
            lockout: Mutex::default(),
        }))
    }

    pub async fn setup_required(&self) -> Result<bool, StoreError> {
        self.0
            .store
            .call(|conn| has_account(conn).map(|has| !has))
            .await
    }

    /// Issues the setup code when there is no account yet. The caller prints
    /// it to stdout, never a log. With `file`, the code is also written there,
    /// readable only by the owner, for a server whose stdout goes to a log
    /// file; the file is deleted once the code is used. A file or code left by
    /// an earlier run is cleared when no code is needed.
    pub async fn issue_setup_code_if_needed(
        &self,
        file: Option<&Path>,
    ) -> Result<Option<String>, AccountError> {
        if let Some(file) = file {
            remove_if_present(file)?;
            *lock(&self.0.setup_code_file) = Some(file.to_path_buf());
        }
        let code = self
            .0
            .store
            .call(|conn| {
                if !has_account(conn)? {
                    setup_code::issue(conn).map(Some)
                } else {
                    setup_code::clear(conn).map(|()| None)
                }
            })
            .await?;
        if let (Some(code), Some(file)) = (&code, file) {
            write_private(file, &format!("{code}\n"))?;
        }
        Ok(code)
    }

    /// Checks the setup code and the passphrase, hashes the passphrase, and
    /// starts the TOTP enrollment setup ends with.
    pub async fn start_setup(
        &self,
        code: &str,
        passphrase: Zeroizing<String>,
        device_name: String,
    ) -> Result<Result<Enrollment, CodeError>, AccountError> {
        let given = code.to_string();
        let checked = self
            .0
            .store
            .call(move |conn| setup_code::check(conn, &given))
            .await?;
        let code = match checked {
            Ok(code) => code,
            Err(e) => return Ok(Err(e)),
        };
        let passphrase_hash = tokio::task::spawn_blocking(move || hash_passphrase(&passphrase))
            .await
            .map_err(StoreError::from)??;
        Ok(Ok(self.add_pending(Pending::Setup {
            code,
            passphrase_hash,
            device_name,
        })))
    }

    /// Ends setup with the first code from the new secret: creates the account
    /// and its backup codes, and uses up the setup code.
    pub async fn finish_setup(
        &self,
        enrollment_id: &str,
        code: &str,
    ) -> Result<Result<SetUp, SetupError>, AccountError> {
        let Some(pending) =
            self.take_pending(enrollment_id, |kind| matches!(kind, Pending::Setup { .. }))
        else {
            return Ok(Err(SetupError::UnknownEnrollment));
        };
        let Some(step) = totp::matching_step(&pending.secret, code, totp::step_at(now_ms()), None)
        else {
            // A mistyped code shouldn't make the user start over.
            self.put_back(enrollment_id, pending);
            return Ok(Err(SetupError::WrongCode));
        };
        let Pending::Setup {
            code: setup_code,
            passphrase_hash,
            device_name,
        } = pending.kind
        else {
            unreachable!("filtered above");
        };
        let secret = pending.secret;
        let (codes, hashes) = new_backup_codes();
        let outcome = self
            .0
            .store
            .call(move |conn| {
                let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                if has_account(&tx)? {
                    return Ok(Err(SetupError::Done));
                }
                if !setup_code::consume(&tx, &setup_code)? {
                    return Ok(Err(SetupError::CodeGone));
                }
                tx.execute(
                    "INSERT INTO account (id, passphrase_hash, totp_secret, totp_last_step, created_at)
                     VALUES (1, ?1, ?2, ?3, ?4)",
                    rusqlite::params![passphrase_hash, secret.as_slice(), step, now_ms()],
                )?;
                replace_backup_codes(&tx, &hashes)?;
                tx.commit()?;
                Ok(Ok(()))
            })
            .await?;
        if let Err(e) = outcome {
            return Ok(Err(e));
        }
        self.remove_setup_code_file();
        Ok(Ok(SetUp {
            device_name,
            backup_codes: codes,
        }))
    }

    /// When sign-ins are refused, how long until they aren't.
    pub fn locked_for(&self) -> Option<Duration> {
        let lockout = lock(&self.0.lockout);
        lockout
            .until
            .and_then(|until| until.checked_duration_since(Instant::now()))
    }

    /// Claims a place for one check, or says the account is locked. With
    /// every place under the limit taken by checks still running, the caller
    /// waits a moment rather than adding an eleventh guess.
    fn begin_attempt(&self) -> Result<Attempt<'_>, AccountError> {
        let mut lockout = lock(&self.0.lockout);
        let now = Instant::now();
        if let Some(left) = lockout
            .until
            .and_then(|until| until.checked_duration_since(now))
        {
            return Err(AccountError::Locked(left));
        }
        prune(&mut lockout.failures, now);
        if lockout.failures.len() + lockout.in_flight >= MAX_FAILURES {
            return Err(AccountError::Locked(Duration::from_secs(1)));
        }
        lockout.in_flight += 1;
        Ok(Attempt(self))
    }

    /// Counts a failed passphrase or code, from anywhere. Past the limit the
    /// account locks: that lets anyone who can reach the server keep the owner
    /// out, which is accepted, since it also caps guessing.
    pub fn record_failure(&self) {
        let mut lockout = lock(&self.0.lockout);
        let now = Instant::now();
        prune(&mut lockout.failures, now);
        lockout.failures.push_back(now);
        if lockout.failures.len() >= MAX_FAILURES {
            lockout.failures.clear();
            lockout.until = Some(now + LOCKOUT);
            tracing::warn!("too many failed sign-ins; the account is locked for 15 minutes");
        }
    }

    fn record_success(&self) {
        lock(&self.0.lockout).failures.clear();
    }

    /// Checks a sign-in: the passphrase, then the second factor. The second
    /// factor is checked either way, so the time taken doesn't show whether
    /// the passphrase was right, but a TOTP step or backup code is only used
    /// up when it was. Every failure counts towards the lockout, and nothing
    /// says which part was wrong. [`AccountError::Locked`] while locked.
    pub async fn check_login(
        &self,
        passphrase: Zeroizing<String>,
        factor: SecondFactor<'_>,
    ) -> Result<bool, AccountError> {
        let attempt = self.begin_attempt()?;
        let Some(stored) = self.passphrase_hash().await? else {
            return Ok(false);
        };
        let matches = tokio::task::spawn_blocking(move || verify_passphrase(&passphrase, &stored))
            .await
            .map_err(StoreError::from)?;
        let factor_ok = match factor {
            SecondFactor::Totp(code) => self.use_totp(code, matches).await?,
            SecondFactor::Backup(code) => self.use_backup_code(code, matches).await?,
        };
        let ok = matches && factor_ok;
        attempt.finish(ok);
        Ok(ok)
    }

    /// Checks a TOTP code alone, for a device proving it is still with its
    /// owner. Failures count towards the lockout like a sign-in's.
    pub async fn check_code(&self, code: &str) -> Result<bool, AccountError> {
        let attempt = self.begin_attempt()?;
        let ok = self.use_totp(code, true).await?;
        attempt.finish(ok);
        Ok(ok)
    }

    /// A wrong one counts towards the lockout; a right one doesn't reset it,
    /// since it proves nothing about the second factor.
    pub async fn check_current_passphrase(
        &self,
        passphrase: Zeroizing<String>,
    ) -> Result<bool, AccountError> {
        let attempt = self.begin_attempt()?;
        let Some(stored) = self.passphrase_hash().await? else {
            return Ok(false);
        };
        let ok = tokio::task::spawn_blocking(move || verify_passphrase(&passphrase, &stored))
            .await
            .map_err(StoreError::from)?;
        if !ok {
            attempt.finish(false);
        }
        Ok(ok)
    }

    /// Whether `passphrase` is the sign-in passphrase. The vault refuses it:
    /// the sign-in hash is weaker, so a copy of the database would then be
    /// the easier way to the vault's passphrase.
    pub async fn is_sign_in_passphrase(
        &self,
        passphrase: Zeroizing<String>,
    ) -> Result<bool, AccountError> {
        let Some(stored) = self.passphrase_hash().await? else {
            return Ok(false);
        };
        Ok(
            tokio::task::spawn_blocking(move || verify_passphrase(&passphrase, &stored))
                .await
                .map_err(StoreError::from)?,
        )
    }

    pub async fn set_passphrase(&self, passphrase: Zeroizing<String>) -> Result<(), AccountError> {
        let hash = tokio::task::spawn_blocking(move || hash_passphrase(&passphrase))
            .await
            .map_err(StoreError::from)??;
        let changed = self
            .0
            .store
            .call(move |conn| {
                conn.execute(
                    "UPDATE account SET passphrase_hash = ?1 WHERE id = 1",
                    [hash],
                )
            })
            .await?;
        // `auth reset` can remove the account under a signed-in device.
        if changed == 0 {
            return Err(AccountError::Gone);
        }
        Ok(())
    }

    /// Starts replacing the TOTP secret. Only `device_id` can confirm it.
    pub fn start_reenroll(&self, device_id: &str) -> Enrollment {
        self.add_pending(Pending::Reenroll {
            device_id: device_id.to_string(),
        })
    }

    /// Confirms a re-enrollment with a code from the new secret, which then
    /// replaces the old one.
    pub async fn finish_reenroll(
        &self,
        enrollment_id: &str,
        device_id: &str,
        code: &str,
    ) -> Result<Result<(), SetupError>, AccountError> {
        let Some(pending) = self.take_pending(
            enrollment_id,
            |kind| matches!(kind, Pending::Reenroll { device_id: d } if d == device_id),
        ) else {
            return Ok(Err(SetupError::UnknownEnrollment));
        };
        let Some(step) = totp::matching_step(&pending.secret, code, totp::step_at(now_ms()), None)
        else {
            self.put_back(enrollment_id, pending);
            return Ok(Err(SetupError::WrongCode));
        };
        let secret = pending.secret;
        let changed = self
            .0
            .store
            .call(move |conn| {
                conn.execute(
                    "UPDATE account SET totp_secret = ?1, totp_last_step = ?2 WHERE id = 1",
                    rusqlite::params![secret.as_slice(), step],
                )
            })
            .await?;
        if changed == 0 {
            return Err(AccountError::Gone);
        }
        Ok(Ok(()))
    }

    /// New backup codes, replacing every old one. Returned in clear once.
    pub async fn regenerate_backup_codes(&self) -> Result<Vec<String>, AccountError> {
        let (codes, hashes) = new_backup_codes();
        self.0
            .store
            .call(move |conn| {
                let tx = conn.transaction()?;
                if !has_account(&tx)? {
                    return Ok(false);
                }
                replace_backup_codes(&tx, &hashes)?;
                tx.commit()?;
                Ok(true)
            })
            .await?
            .then_some(codes)
            .ok_or(AccountError::Gone)
    }

    pub async fn backup_codes_left(&self) -> Result<i64, StoreError> {
        self.0
            .store
            .call(|conn| {
                conn.query_row(
                    "SELECT COUNT(*) FROM backup_codes WHERE used_at IS NULL",
                    [],
                    |row| row.get(0),
                )
            })
            .await
    }

    async fn passphrase_hash(&self) -> Result<Option<String>, StoreError> {
        self.0
            .store
            .call(|conn| {
                conn.query_row(
                    "SELECT passphrase_hash FROM account WHERE id = 1",
                    [],
                    |row| row.get(0),
                )
                .optional()
            })
            .await
    }

    /// Accepts a current code once: with `consume`, the step it matched
    /// becomes the last one accepted, in the transaction that checks it, so
    /// two requests racing with one code can't both pass.
    async fn use_totp(&self, code: &str, consume: bool) -> Result<bool, StoreError> {
        let code = code.to_string();
        self.0
            .store
            .call(move |conn| {
                let tx =
                    conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
                let row: Option<(Vec<u8>, Option<i64>)> = tx
                    .query_row(
                        "SELECT totp_secret, totp_last_step FROM account WHERE id = 1",
                        [],
                        |row| Ok((row.get(0)?, row.get(1)?)),
                    )
                    .optional()?;
                let Some((secret, last_step)) = row else {
                    return Ok(false);
                };
                let secret = Zeroizing::new(secret);
                let Some(step) =
                    totp::matching_step(&secret, &code, totp::step_at(now_ms()), last_step)
                else {
                    return Ok(false);
                };
                if !consume {
                    return Ok(true);
                }
                tx.execute(
                    "UPDATE account SET totp_last_step = ?1 WHERE id = 1",
                    [step],
                )?;
                tx.commit()?;
                Ok(true)
            })
            .await
    }

    /// Whether `code` is an unused backup code; with `consume`, also uses it up.
    async fn use_backup_code(&self, code: &str, consume: bool) -> Result<bool, StoreError> {
        let hash = setup_code::hash(code).to_vec();
        self.0
            .store
            .call(move |conn| {
                if !consume {
                    return conn
                        .query_row(
                            "SELECT 1 FROM backup_codes WHERE hash = ?1 AND used_at IS NULL",
                            [&hash],
                            |_| Ok(()),
                        )
                        .optional()
                        .map(|row| row.is_some());
                }
                Ok(conn.execute(
                    "UPDATE backup_codes SET used_at = ?1 WHERE hash = ?2 AND used_at IS NULL",
                    rusqlite::params![now_ms(), hash],
                )? == 1)
            })
            .await
    }

    fn add_pending(&self, kind: Pending) -> Enrollment {
        let secret = totp::new_secret();
        let secret_base32 = totp::base32(&secret);
        let otpauth_uri = totp::otpauth_uri(&secret_base32);
        let qr_svg = totp::qr_svg(&otpauth_uri);
        let id = new_id();
        let mut pending = lock(&self.0.pending);
        pending.retain(|_, p| p.at.elapsed() < ENROLLMENT_TTL);
        if pending.len() >= MAX_ENROLLMENTS
            && let Some(oldest) = pending
                .iter()
                .min_by_key(|(_, p)| p.at)
                .map(|(id, _)| id.clone())
        {
            pending.remove(&oldest);
        }
        pending.insert(
            id.clone(),
            PendingEnrollment {
                at: Instant::now(),
                secret,
                kind,
            },
        );
        Enrollment {
            id,
            secret_base32,
            otpauth_uri,
            qr_svg,
        }
    }

    fn take_pending(
        &self,
        id: &str,
        wanted: impl Fn(&Pending) -> bool,
    ) -> Option<PendingEnrollment> {
        let mut pending = lock(&self.0.pending);
        let found = pending.get(id)?;
        if found.at.elapsed() >= ENROLLMENT_TTL {
            pending.remove(id);
            return None;
        }
        if !wanted(&found.kind) {
            return None;
        }
        pending.remove(id)
    }

    fn put_back(&self, id: &str, enrollment: PendingEnrollment) {
        lock(&self.0.pending).insert(id.to_string(), enrollment);
    }

    fn remove_setup_code_file(&self) {
        if let Some(file) = lock(&self.0.setup_code_file).take()
            && let Err(e) = remove_if_present(&file)
        {
            tracing::warn!("couldn't delete the used setup code file: {e}");
        }
    }
}

/// Removes the account so setup runs again, and issues a new setup code. For
/// `yarvis-server auth reset`, run by whoever can use the server's terminal,
/// the same trust the first setup code needs. Signed-in devices stay signed in.
pub fn reset(conn: &mut rusqlite::Connection) -> rusqlite::Result<String> {
    let tx = conn.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    tx.execute("DELETE FROM backup_codes", [])?;
    tx.execute("DELETE FROM account", [])?;
    let code = setup_code::issue(&tx)?;
    tx.commit()?;
    Ok(code)
}

fn new_backup_codes() -> (Vec<String>, Vec<CodeHash>) {
    (0..BACKUP_CODES)
        .map(|_| {
            let code = setup_code::random_code();
            let hash = setup_code::hash(&code);
            (code, hash)
        })
        .unzip()
}

fn replace_backup_codes(
    tx: &rusqlite::Transaction<'_>,
    hashes: &[CodeHash],
) -> rusqlite::Result<()> {
    tx.execute("DELETE FROM backup_codes", [])?;
    for hash in hashes {
        tx.execute(
            "INSERT INTO backup_codes (hash, created_at) VALUES (?1, ?2)",
            rusqlite::params![hash.to_vec(), now_ms()],
        )?;
    }
    Ok(())
}

pub fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Creates the file fresh with mode 0600, so it is never readable by others,
/// even for a moment.
pub fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(text.as_bytes())
}

/// The guarded state holds no invariant a panic could break halfway, so a
/// poisoned lock is still usable.
fn has_account(conn: &rusqlite::Connection) -> rusqlite::Result<bool> {
    conn.query_row("SELECT EXISTS (SELECT 1 FROM account)", [], |row| {
        row.get(0)
    })
}

/// Drops failures older than the window.
fn prune(failures: &mut VecDeque<Instant>, now: Instant) {
    while failures
        .front()
        .is_some_and(|at| now.duration_since(*at) > FAILURE_WINDOW)
    {
        failures.pop_front();
    }
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_passphrase_hash_verifies_only_its_passphrase() {
        let hash = hash_passphrase("correct horse battery").unwrap();
        assert!(hash.starts_with("$argon2id$"), "{hash}");
        assert!(verify_passphrase("correct horse battery", &hash));
        assert!(!verify_passphrase("correct horse batterY", &hash));
        assert!(!verify_passphrase("anything", "not a hash"));
    }

    #[test]
    fn short_and_huge_passphrases_are_refused() {
        assert!(check_passphrase_shape("eleven char").is_err());
        assert!(check_passphrase_shape("twelve chars").is_ok());
        assert!(check_passphrase_shape(&"x".repeat(MAX_PASSPHRASE_BYTES + 1)).is_err());
    }

    #[test]
    fn ten_failures_lock_the_account_and_a_success_resets_the_count() {
        let account = Account::new(Store::open_in_memory().unwrap());
        for _ in 0..MAX_FAILURES - 1 {
            account.record_failure();
        }
        account.record_success();
        account.record_failure();
        assert_eq!(account.locked_for(), None);
        for _ in 0..MAX_FAILURES - 1 {
            account.record_failure();
        }
        assert!(
            account
                .locked_for()
                .is_some_and(|left| left > Duration::from_secs(14 * 60))
        );
    }
}
