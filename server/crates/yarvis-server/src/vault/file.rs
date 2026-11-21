//! The vault file's format.
//!
//! One random 256-bit vault key encrypts the secrets blob with
//! XChaCha20-Poly1305. The vault key itself is never stored in the clear.
//! Each wrapper holds a copy of the vault key, encrypted under a key derived
//! from a secret the server does not keep: a passkey's PRF output, or a
//! recovery key the user writes down. Any one wrapper unlocks the vault.

use std::collections::BTreeMap;
use std::path::Path;

use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64;
use chacha20poly1305::aead::{Aead, KeyInit, Payload};
use chacha20poly1305::{XChaCha20Poly1305, XNonce};
use hkdf::Hkdf;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::Sha256;
use zeroize::{Zeroize, ZeroizeOnDrop, Zeroizing};

const FORMAT_VERSION: u32 = 1;
const KEY_LEN: usize = 32;

#[derive(Debug, thiserror::Error)]
pub enum VaultError {
    #[error("the vault is locked")]
    Locked,
    #[error("the vault is already unlocked")]
    AlreadyUnlocked,
    #[error("there is no vault yet; run `yarvis-server vault init` on the server")]
    Uninitialized,
    /// The secret did not decrypt any matching wrapper. Deliberately carries
    /// no detail, so callers can't tell a wrong secret from a corrupt wrapper.
    #[error("wrong key or corrupt wrapper")]
    WrongKey,
    #[error("no wrapper matches this credential")]
    NoMatchingWrapper,
    #[error("refusing to remove the last wrapper: the vault would become unrecoverable")]
    LastWrapper,
    #[error("wrapper id already exists: {0}")]
    DuplicateWrapper(String),
    #[error("secrets blob failed to decrypt with the vault key (file tampered or corrupt)")]
    CorruptSecrets,
    #[error("a vault already exists here")]
    AlreadyExists,
    #[error("unsupported vault format version {0}")]
    UnsupportedVersion(u32),
    #[error("bad encoding: {0}")]
    Encoding(String),
    #[error(transparent)]
    Io(#[from] std::io::Error),
}

/// The 256-bit key that encrypts the secrets. Zeroized on drop.
#[derive(Clone, Zeroize, ZeroizeOnDrop)]
pub struct VaultKey([u8; KEY_LEN]);

impl VaultKey {
    fn random() -> Self {
        let mut k = [0u8; KEY_LEN];
        rand::rng().fill_bytes(&mut k);
        Self(k)
    }
}

/// A secret that unwraps the vault key: a passkey PRF output or a recovery key.
/// Held in a zeroizing buffer and never serialized.
pub struct UnwrapSecret(Zeroizing<Vec<u8>>);

impl UnwrapSecret {
    pub fn from_bytes(bytes: Vec<u8>) -> Self {
        Self(Zeroizing::new(bytes))
    }
}

/// A recovery key: 32 random bytes shown to the user once, base64url encoded.
pub struct RecoveryKey(Zeroizing<String>);

impl RecoveryKey {
    pub fn generate() -> Self {
        let mut raw = Zeroizing::new([0u8; KEY_LEN]);
        rand::rng().fill_bytes(raw.as_mut());
        Self(Zeroizing::new(B64.encode(raw.as_ref())))
    }

    pub fn parse(s: &str) -> Result<Self, VaultError> {
        let raw = Zeroizing::new(
            B64.decode(s.trim())
                .map_err(|_| VaultError::Encoding("recovery key is not base64url".into()))?,
        );
        if raw.len() != KEY_LEN {
            return Err(VaultError::Encoding("recovery key must be 32 bytes".into()));
        }
        Ok(Self(Zeroizing::new(s.trim().to_owned())))
    }

    pub fn expose(&self) -> &str {
        &self.0
    }

    pub fn as_unwrap_secret(&self) -> UnwrapSecret {
        let raw = B64
            .decode(self.0.as_bytes())
            .expect("validated on construction");
        UnwrapSecret::from_bytes(raw)
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum WrapperKind {
    /// Unwrapped by the PRF output of one WebAuthn credential. `prf_salt` is the
    /// PRF input the client sends to the authenticator; it's public.
    PasskeyPrf {
        credential_id: String,
        prf_salt: String,
    },
    Recovery,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Wrapper {
    pub id: String,
    pub label: String,
    pub kind: WrapperKind,
    hkdf_salt: String,
    nonce: String,
    wrapped_key: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
struct Sealed {
    nonce: String,
    ciphertext: String,
}

/// The on-disk vault. Everything in it is safe to store unencrypted:
/// the secrets are sealed and every wrapper is sealed.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct VaultFile {
    version: u32,
    vault_id: String,
    pub wrappers: Vec<Wrapper>,
    secrets: Sealed,
}

/// Decrypted secrets, keyed by name. Values are zeroized on drop.
#[derive(Default, Serialize, Deserialize)]
pub struct Secrets(BTreeMap<String, Zeroizing<Vec<u8>>>);

impl Secrets {
    pub fn get(&self, name: &str) -> Option<&[u8]> {
        self.0.get(name).map(|v| v.as_slice())
    }

    /// Returns the value it replaced, so a failed save can put it back.
    pub fn insert(&mut self, name: &str, value: Vec<u8>) -> Option<Zeroizing<Vec<u8>>> {
        self.0.insert(name.to_owned(), Zeroizing::new(value))
    }

    pub fn restore(&mut self, name: &str, previous: Option<Zeroizing<Vec<u8>>>) {
        match previous {
            Some(value) => self.0.insert(name.to_owned(), value),
            None => self.0.remove(name),
        };
    }
}

/// An unlocked vault: the file plus the vault key and decrypted secrets in memory.
pub struct Unlocked {
    pub file: VaultFile,
    key: VaultKey,
    pub secrets: Secrets,
}

/// The id of the wrapper for one passkey credential (base64url).
pub fn passkey_wrapper_id(credential_id: &str) -> String {
    format!("passkey:{credential_id}")
}

fn random_b64(len: usize) -> String {
    let mut b = vec![0u8; len];
    rand::rng().fill_bytes(&mut b);
    B64.encode(b)
}

fn decode(s: &str) -> Result<Vec<u8>, VaultError> {
    B64.decode(s)
        .map_err(|e| VaultError::Encoding(e.to_string()))
}

/// Derives the key-encryption key for one wrapper. The wrapper id and vault id
/// go into `info` so a wrapper copied into another vault, or relabelled, won't open.
fn derive_kek(
    secret: &UnwrapSecret,
    hkdf_salt: &[u8],
    vault_id: &str,
    wrapper_id: &str,
) -> Zeroizing<[u8; KEY_LEN]> {
    let hk = Hkdf::<Sha256>::new(Some(hkdf_salt), &secret.0);
    let info = format!("yarvis-vault/v1/wrap/{vault_id}/{wrapper_id}");
    let mut okm = Zeroizing::new([0u8; KEY_LEN]);
    hk.expand(info.as_bytes(), okm.as_mut())
        .expect("32 bytes is a valid HKDF-SHA256 output length");
    okm
}

fn wrapper_aad(vault_id: &str, w_id: &str, kind: &WrapperKind) -> Vec<u8> {
    let kind = serde_json::to_string(kind).expect("kind serializes");
    format!("yarvis-vault/v1/wrapper/{vault_id}/{w_id}/{kind}").into_bytes()
}

fn secrets_aad(vault_id: &str) -> Vec<u8> {
    format!("yarvis-vault/v1/secrets/{vault_id}").into_bytes()
}

fn seal(key: &[u8; KEY_LEN], aad: &[u8], plaintext: &[u8]) -> Sealed {
    let cipher = XChaCha20Poly1305::new(key.into());
    let mut nonce = [0u8; 24];
    rand::rng().fill_bytes(&mut nonce);
    let ciphertext = cipher
        .encrypt(
            XNonce::from_slice(&nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .expect("XChaCha20-Poly1305 encryption does not fail for in-memory buffers");
    Sealed {
        nonce: B64.encode(nonce),
        ciphertext: B64.encode(ciphertext),
    }
}

fn open(key: &[u8; KEY_LEN], aad: &[u8], sealed: &Sealed) -> Option<Zeroizing<Vec<u8>>> {
    let nonce = decode(&sealed.nonce).ok()?;
    let ct = decode(&sealed.ciphertext).ok()?;
    if nonce.len() != 24 {
        return None;
    }
    let cipher = XChaCha20Poly1305::new(key.into());
    cipher
        .decrypt(XNonce::from_slice(&nonce), Payload { msg: &ct, aad })
        .ok()
        .map(Zeroizing::new)
}

fn make_wrapper(
    vault_id: &str,
    key: &VaultKey,
    id: String,
    label: String,
    kind: WrapperKind,
    secret: &UnwrapSecret,
) -> Wrapper {
    let mut hkdf_salt = [0u8; 32];
    rand::rng().fill_bytes(&mut hkdf_salt);
    let kek = derive_kek(secret, &hkdf_salt, vault_id, &id);
    let sealed = seal(&kek, &wrapper_aad(vault_id, &id, &kind), &key.0);
    Wrapper {
        id,
        label,
        kind,
        hkdf_salt: B64.encode(hkdf_salt),
        nonce: sealed.nonce,
        wrapped_key: sealed.ciphertext,
    }
}

fn try_unwrap(vault_id: &str, w: &Wrapper, secret: &UnwrapSecret) -> Option<VaultKey> {
    let salt = decode(&w.hkdf_salt).ok()?;
    let kek = derive_kek(secret, &salt, vault_id, &w.id);
    let sealed = Sealed {
        nonce: w.nonce.clone(),
        ciphertext: w.wrapped_key.clone(),
    };
    let raw = open(&kek, &wrapper_aad(vault_id, &w.id, &w.kind), &sealed)?;
    let bytes: [u8; KEY_LEN] = raw.as_slice().try_into().ok()?;
    Some(VaultKey(bytes))
}

impl VaultFile {
    /// Creates a vault with a single recovery-key wrapper and the given secrets.
    /// Returns it already unlocked, plus the recovery key to show the user once.
    pub fn create(secrets: Secrets) -> (Unlocked, RecoveryKey) {
        let vault_id = random_b64(16);
        let key = VaultKey::random();
        let recovery = RecoveryKey::generate();
        let wrapper = make_wrapper(
            &vault_id,
            &key,
            "recovery".into(),
            "Recovery key".into(),
            WrapperKind::Recovery,
            &recovery.as_unwrap_secret(),
        );
        let file = VaultFile {
            version: FORMAT_VERSION,
            vault_id,
            wrappers: vec![wrapper],
            secrets: Sealed {
                nonce: String::new(),
                ciphertext: String::new(),
            },
        };
        let mut unlocked = Unlocked { file, key, secrets };
        unlocked.reseal();
        (unlocked, recovery)
    }

    pub fn load(path: &Path) -> Result<Self, VaultError> {
        let bytes = std::fs::read(path)?;
        let file: VaultFile =
            serde_json::from_slice(&bytes).map_err(|e| VaultError::Encoding(e.to_string()))?;
        if file.version != FORMAT_VERSION {
            return Err(VaultError::UnsupportedVersion(file.version));
        }
        Ok(file)
    }

    /// Writes atomically (temp file + rename) with 0600 permissions. The temp
    /// file is created fresh, so a leftover one with wider permissions is
    /// never reused.
    pub fn save(&self, path: &Path) -> Result<(), VaultError> {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let tmp = path.with_extension("json.tmp");
        match std::fs::remove_file(&tmp) {
            Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
            _ => {}
        }
        let json = serde_json::to_vec_pretty(self).expect("vault serializes");
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)?;
        f.write_all(&json)?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    }

    /// Writes a vault that must not replace one already at `path`: `vault
    /// init` run twice would otherwise throw away every secret.
    pub fn save_new(&self, path: &Path) -> Result<(), VaultError> {
        if path.try_exists()? {
            return Err(VaultError::AlreadyExists);
        }
        self.save(path)
    }

    pub fn passkey_wrapper(&self, credential_id: &str) -> Option<&Wrapper> {
        self.wrappers.iter().find(|w| {
            matches!(&w.kind, WrapperKind::PasskeyPrf { credential_id: c, .. } if c == credential_id)
        })
    }

    /// Unlocks with a passkey's PRF output.
    pub fn unlock_with_passkey(
        self,
        credential_id: &str,
        prf_output: &UnwrapSecret,
    ) -> Result<Unlocked, VaultError> {
        let w = self
            .passkey_wrapper(credential_id)
            .ok_or(VaultError::NoMatchingWrapper)?;
        let key = try_unwrap(&self.vault_id, w, prf_output).ok_or(VaultError::WrongKey)?;
        self.finish_unlock(key)
    }

    pub fn unlock_with_recovery(self, recovery: &RecoveryKey) -> Result<Unlocked, VaultError> {
        let secret = recovery.as_unwrap_secret();
        let key = self
            .wrappers
            .iter()
            .filter(|w| w.kind == WrapperKind::Recovery)
            .find_map(|w| try_unwrap(&self.vault_id, w, &secret))
            .ok_or(VaultError::WrongKey)?;
        self.finish_unlock(key)
    }

    fn finish_unlock(self, key: VaultKey) -> Result<Unlocked, VaultError> {
        let plaintext = open(&key.0, &secrets_aad(&self.vault_id), &self.secrets)
            .ok_or(VaultError::CorruptSecrets)?;
        let secrets: Secrets =
            serde_json::from_slice(&plaintext).map_err(|_| VaultError::CorruptSecrets)?;
        Ok(Unlocked {
            file: self,
            key,
            secrets,
        })
    }
}

impl Unlocked {
    /// Re-encrypts the secrets after a change. Uses a fresh nonce every time.
    pub fn reseal(&mut self) {
        let plaintext =
            Zeroizing::new(serde_json::to_vec(&self.secrets).expect("secrets serialize"));
        self.file.secrets = seal(&self.key.0, &secrets_aad(&self.file.vault_id), &plaintext);
    }

    /// Adds a wrapper for a passkey. Only possible while unlocked, because it
    /// needs the vault key.
    pub fn add_passkey_wrapper(
        &mut self,
        credential_id: &str,
        prf_salt: &str,
        label: &str,
        prf_output: &UnwrapSecret,
    ) -> Result<(), VaultError> {
        let id = passkey_wrapper_id(credential_id);
        if self.file.wrappers.iter().any(|w| w.id == id) {
            return Err(VaultError::DuplicateWrapper(id));
        }
        let w = make_wrapper(
            &self.file.vault_id,
            &self.key,
            id,
            label.into(),
            WrapperKind::PasskeyPrf {
                credential_id: credential_id.into(),
                prf_salt: prf_salt.into(),
            },
            prf_output,
        );
        self.file.wrappers.push(w);
        Ok(())
    }

    /// Replaces the recovery wrapper with a new recovery key.
    pub fn rotate_recovery_key(&mut self) -> RecoveryKey {
        let recovery = RecoveryKey::generate();
        self.file
            .wrappers
            .retain(|w| w.kind != WrapperKind::Recovery);
        let w = make_wrapper(
            &self.file.vault_id,
            &self.key,
            "recovery".into(),
            "Recovery key".into(),
            WrapperKind::Recovery,
            &recovery.as_unwrap_secret(),
        );
        self.file.wrappers.push(w);
        recovery
    }

    pub fn remove_wrapper(&mut self, wrapper_id: &str) -> Result<(), VaultError> {
        if !self.file.wrappers.iter().any(|w| w.id == wrapper_id) {
            return Err(VaultError::NoMatchingWrapper);
        }
        if self.file.wrappers.len() == 1 {
            return Err(VaultError::LastWrapper);
        }
        self.file.wrappers.retain(|w| w.id != wrapper_id);
        Ok(())
    }

    /// Drops the key and secrets (both zeroize on drop) and returns the locked file.
    pub fn lock(self) -> VaultFile {
        self.file.clone()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stand_in_prf(seed: u8) -> UnwrapSecret {
        // Real PRF outputs are 32 bytes from HMAC-SHA256 on the authenticator.
        UnwrapSecret::from_bytes(vec![seed; 32])
    }

    fn sample_secrets() -> Secrets {
        let mut s = Secrets::default();
        s.insert("anthropic_api_key", b"sk-test-not-real".to_vec());
        s
    }

    #[test]
    fn create_lock_and_unlock_with_recovery_key() {
        let (unlocked, recovery) = VaultFile::create(sample_secrets());
        let locked = unlocked.lock();
        let reopened = locked.unlock_with_recovery(&recovery).unwrap();
        assert_eq!(
            reopened.secrets.get("anthropic_api_key").unwrap(),
            b"sk-test-not-real"
        );
    }

    #[test]
    fn wrong_recovery_key_fails_cleanly() {
        let (unlocked, _recovery) = VaultFile::create(sample_secrets());
        let locked = unlocked.lock();
        let wrong = RecoveryKey::generate();
        assert!(matches!(
            locked.unlock_with_recovery(&wrong),
            Err(VaultError::WrongKey)
        ));
    }

    #[test]
    fn malformed_recovery_key_is_rejected_before_crypto() {
        assert!(RecoveryKey::parse("not base64!").is_err());
        assert!(RecoveryKey::parse("AAAA").is_err());
    }

    #[test]
    fn passkey_wrapper_round_trip_and_wrong_prf() {
        let (mut unlocked, _recovery) = VaultFile::create(sample_secrets());
        unlocked
            .add_passkey_wrapper("cred-A", "salt-A", "Laptop Touch ID", &stand_in_prf(7))
            .unwrap();
        unlocked
            .add_passkey_wrapper("cred-B", "salt-B", "YubiKey", &stand_in_prf(9))
            .unwrap();
        let locked = unlocked.lock();

        let a = locked
            .clone()
            .unlock_with_passkey("cred-A", &stand_in_prf(7))
            .unwrap();
        assert!(a.secrets.get("anthropic_api_key").is_some());
        let b = locked
            .clone()
            .unlock_with_passkey("cred-B", &stand_in_prf(9))
            .unwrap();
        assert!(b.secrets.get("anthropic_api_key").is_some());

        // B's PRF output must not open A's wrapper.
        assert!(matches!(
            locked
                .clone()
                .unlock_with_passkey("cred-A", &stand_in_prf(9)),
            Err(VaultError::WrongKey)
        ));
        assert!(matches!(
            locked.unlock_with_passkey("cred-unknown", &stand_in_prf(7)),
            Err(VaultError::NoMatchingWrapper)
        ));
    }

    #[test]
    fn duplicate_passkey_wrapper_is_rejected() {
        let (mut unlocked, _) = VaultFile::create(sample_secrets());
        unlocked
            .add_passkey_wrapper("cred-A", "s", "one", &stand_in_prf(1))
            .unwrap();
        assert!(matches!(
            unlocked.add_passkey_wrapper("cred-A", "s", "two", &stand_in_prf(2)),
            Err(VaultError::DuplicateWrapper(_))
        ));
    }

    #[test]
    fn remove_wrapper_revokes_it_and_last_wrapper_is_protected() {
        let (mut unlocked, recovery) = VaultFile::create(sample_secrets());
        unlocked
            .add_passkey_wrapper("cred-A", "s", "laptop", &stand_in_prf(7))
            .unwrap();
        unlocked.remove_wrapper("passkey:cred-A").unwrap();
        assert!(matches!(
            unlocked.remove_wrapper("recovery"),
            Err(VaultError::LastWrapper)
        ));
        let locked = unlocked.lock();
        assert!(matches!(
            locked
                .clone()
                .unlock_with_passkey("cred-A", &stand_in_prf(7)),
            Err(VaultError::NoMatchingWrapper)
        ));
        locked.unlock_with_recovery(&recovery).unwrap();
    }

    #[test]
    fn rotating_recovery_key_invalidates_the_old_one() {
        let (mut unlocked, old) = VaultFile::create(sample_secrets());
        let new = unlocked.rotate_recovery_key();
        let locked = unlocked.lock();
        assert!(matches!(
            locked.clone().unlock_with_recovery(&old),
            Err(VaultError::WrongKey)
        ));
        locked.unlock_with_recovery(&new).unwrap();
    }

    #[test]
    fn tampered_secrets_fail_authentication() {
        let (unlocked, recovery) = VaultFile::create(sample_secrets());
        let mut locked = unlocked.lock();
        let mut ct = decode(&locked.secrets.ciphertext).unwrap();
        ct[0] ^= 1;
        locked.secrets.ciphertext = B64.encode(ct);
        assert!(matches!(
            locked.unlock_with_recovery(&recovery),
            Err(VaultError::CorruptSecrets)
        ));
    }

    #[test]
    fn wrapper_moved_between_vaults_does_not_open() {
        let (mut a, _) = VaultFile::create(sample_secrets());
        a.add_passkey_wrapper("cred-A", "s", "laptop", &stand_in_prf(7))
            .unwrap();
        let a_wrapper = a.file.passkey_wrapper("cred-A").unwrap().clone();

        let (b, _) = VaultFile::create(sample_secrets());
        let mut b = b.lock();
        b.wrappers.push(a_wrapper);
        assert!(matches!(
            b.unlock_with_passkey("cred-A", &stand_in_prf(7)),
            Err(VaultError::WrongKey)
        ));
    }

    #[test]
    fn save_and_load_round_trip_with_private_permissions() {
        use std::os::unix::fs::PermissionsExt;
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("vault.json");
        let (mut unlocked, recovery) = VaultFile::create(sample_secrets());
        unlocked.secrets.insert("another", b"value".to_vec());
        unlocked.reseal();
        unlocked.file.save(&path).unwrap();

        let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode, 0o600);
        let on_disk = std::fs::read_to_string(&path).unwrap();
        assert!(!on_disk.contains("sk-test-not-real"));

        let loaded = VaultFile::load(&path).unwrap();
        let reopened = loaded.unlock_with_recovery(&recovery).unwrap();
        assert_eq!(reopened.secrets.get("another").unwrap(), b"value");
    }
}
