//! The vault as a [`SecretBackend`]: the secrets blob is one of its secrets.

use super::{SECRETS_BLOB, Vault, VaultError};
use crate::secret_store::{SecretBackend, SecretError};

pub struct VaultBackend {
    vault: Vault,
}

impl VaultBackend {
    pub fn new(vault: Vault) -> Self {
        Self { vault }
    }
}

fn to_secret_error(e: VaultError) -> SecretError {
    match e {
        VaultError::Locked => SecretError::Locked,
        other => SecretError::Backend(other.to_string()),
    }
}

impl SecretBackend for VaultBackend {
    /// `Ok(None)` only for an unlocked vault that has never stored a blob. A
    /// locked or missing vault is an error, so the read-modify-write above
    /// this never mistakes it for an empty store.
    fn read_root(&self) -> Result<Option<String>, SecretError> {
        let Some(bytes) = self.vault.secret(SECRETS_BLOB).map_err(to_secret_error)? else {
            return Ok(None);
        };
        String::from_utf8(bytes.to_vec())
            .map(Some)
            .map_err(|_| SecretError::Backend("the stored secrets blob isn't UTF-8".into()))
    }

    fn write_root(&self, blob: &str) -> Result<(), SecretError> {
        self.vault
            .set_secret(SECRETS_BLOB, blob.as_bytes().to_vec())
            .map_err(to_secret_error)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locked_reads_and_writes_fail_and_never_look_empty() {
        let dir = tempfile::tempdir().unwrap();
        let created = Vault::init(dir.path(), false).unwrap();
        let vault = Vault::new(dir.path());
        let backend = vault.secret_backend();
        assert!(matches!(backend.read_root(), Err(SecretError::Locked)));
        assert!(matches!(backend.write_root("{}"), Err(SecretError::Locked)));

        vault.unlock_with_recovery(&created.recovery_key).unwrap();
        assert_eq!(backend.read_root().unwrap(), None);
        backend.write_root(r#"{"anthropic_api_key":"k"}"#).unwrap();
        assert_eq!(
            backend.read_root().unwrap().as_deref(),
            Some(r#"{"anthropic_api_key":"k"}"#)
        );

        vault.lock();
        assert!(matches!(backend.read_root(), Err(SecretError::Locked)));
    }

    #[test]
    fn a_missing_vault_is_an_error_not_an_empty_store() {
        let dir = tempfile::tempdir().unwrap();
        let backend = Vault::new(dir.path()).secret_backend();
        assert!(matches!(backend.read_root(), Err(SecretError::Locked)));
    }
}
