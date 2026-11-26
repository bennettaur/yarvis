//! The secrets blob in the macOS Keychain, through `keyring`.
//!
//! The service and account match the desktop app's, so a server on the same
//! Mac reads the item the app has been writing. The Keychain belongs to a
//! logged-in session: a server started at boot, before anyone logs in, can't
//! reach it and needs the vault backend instead.
//!
//! Off macOS there is no Keychain, and `keyring`'s fallback store forgets
//! everything between calls. Reading that as "empty" would let the next write
//! replace every secret, so off macOS every call fails instead.

use super::{SecretBackend, SecretError};

/// Keychain service name under which the Yarvis secret item is grouped.
pub const SERVICE: &str = "com.mikebennett.yarvis";

/// Account name of the single Keychain item that holds the secrets JSON object.
pub const SECRETS_ACCOUNT: &str = "secrets";

#[derive(Debug, Default)]
pub struct KeychainBackend;

#[cfg(target_os = "macos")]
impl SecretBackend for KeychainBackend {
    fn read_root(&self) -> Result<Option<String>, SecretError> {
        match entry()?.get_password() {
            Ok(blob) => Ok(Some(blob)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(SecretError::Backend(e.to_string())),
        }
    }

    fn write_root(&self, blob: &str) -> Result<(), SecretError> {
        entry()?
            .set_password(blob)
            .map_err(|e| SecretError::Backend(e.to_string()))
    }
}

#[cfg(target_os = "macos")]
fn entry() -> Result<keyring::Entry, SecretError> {
    keyring::Entry::new(SERVICE, SECRETS_ACCOUNT).map_err(|e| SecretError::Backend(e.to_string()))
}

#[cfg(not(target_os = "macos"))]
const NOT_MACOS: &str =
    "the Keychain backend only works on macOS; set [secrets] backend in server.toml";

#[cfg(not(target_os = "macos"))]
impl SecretBackend for KeychainBackend {
    fn read_root(&self) -> Result<Option<String>, SecretError> {
        Err(SecretError::Backend(NOT_MACOS.into()))
    }

    fn write_root(&self, _blob: &str) -> Result<(), SecretError> {
        Err(SecretError::Backend(NOT_MACOS.into()))
    }
}
