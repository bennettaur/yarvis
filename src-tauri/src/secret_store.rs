//! Where the secrets blob is kept.
//!
//! [`crate::keychain`] owns *what* the blob contains; this module owns the one
//! decision of which store it lives in. Both stores hold the identical JSON
//! object in a single item, so the choice is invisible to every module that
//! nests a subtree under it.
//!
//! The selection is read from `~/.yarvis/settings.json` on every access rather
//! than cached at startup. `dev:instance` copies share that file, so a cached
//! backend would leave a second instance writing to the store the first one
//! just switched away from — the same reason `settings.rs` re-reads before
//! every write.

use keyring::Entry;

use crate::onepassword::{self, ItemRef};
use crate::settings;

/// Keychain service name under which the Yarvis secret item is grouped.
const SERVICE: &str = "com.mikebennett.yarvis";

/// Account name of the single Keychain item that holds the secrets JSON object.
const SECRETS_ACCOUNT: &str = "secrets";

/// Value of `settings.secretBackend` that selects 1Password. Anything else,
/// including absent, means the Keychain — a settings file naming a backend this
/// build doesn't know must not leave the app with no store at all.
pub const ONEPASSWORD: &str = "onepassword";

/// Value of `settings.secretBackend` that selects the macOS Keychain.
pub const KEYCHAIN: &str = "keychain";

/// A place the secrets blob can live.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Store {
    Keychain,
    OnePassword(ItemRef),
}

impl Store {
    /// Reads the raw blob, or `None` when the store is reachable but holds
    /// nothing yet. An unreachable store is an `Err`: callers write back what
    /// they read, so "empty" and "could not tell" must not collapse together.
    pub fn read(&self) -> Result<Option<String>, String> {
        match self {
            Self::Keychain => match keychain_entry()?.get_password() {
                Ok(blob) => Ok(Some(blob)),
                Err(keyring::Error::NoEntry) => Ok(None),
                Err(e) => Err(e.to_string()),
            },
            Self::OnePassword(item) => onepassword::read_blob(item),
        }
    }

    pub fn write(&self, blob: &str) -> Result<(), String> {
        match self {
            Self::Keychain => keychain_entry()?
                .set_password(blob)
                .map_err(|e| e.to_string()),
            Self::OnePassword(item) => onepassword::write_blob(item, blob),
        }
    }

    /// How the store names itself in an error the user reads.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Keychain => "the macOS Keychain",
            Self::OnePassword(_) => "1Password",
        }
    }
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, SECRETS_ACCOUNT).map_err(|e| e.to_string())
}

/// Builds the store described by `backend`/`vault`/`item`, rejecting a
/// 1Password selection that is missing either part. Pure, so the settings
/// validation and the live lookup below agree by construction.
pub fn store_from(
    backend: Option<&str>,
    vault: Option<&str>,
    item: Option<&str>,
) -> Result<Store, String> {
    match backend {
        Some(ONEPASSWORD) => Ok(Store::OnePassword(ItemRef::new(
            vault.unwrap_or_default(),
            item.unwrap_or_default(),
        )?)),
        _ => Ok(Store::Keychain),
    }
}

/// The store the app is currently configured to use. A settings file that
/// selects 1Password without a usable vault/item falls back to the Keychain
/// rather than failing every read: the user is one hand-edit away from having
/// no store at all otherwise, and the Keychain copy is what they left behind.
pub fn active() -> Store {
    let settings = settings::from_disk();
    store_from(
        settings.secret_backend.as_deref(),
        settings.one_password_vault.as_deref(),
        settings.one_password_item.as_deref(),
    )
    .unwrap_or(Store::Keychain)
}

#[cfg(test)]
mod tests {
    use super::{store_from, Store, ONEPASSWORD};

    #[test]
    fn an_unset_or_unknown_backend_is_the_keychain() {
        assert_eq!(store_from(None, None, None).unwrap(), Store::Keychain);
        assert_eq!(
            store_from(Some("keychain"), None, None).unwrap(),
            Store::Keychain
        );
        assert_eq!(
            store_from(Some("vault-of-the-future"), None, None).unwrap(),
            Store::Keychain
        );
    }

    #[test]
    fn onepassword_needs_both_a_vault_and_an_item() {
        assert!(store_from(Some(ONEPASSWORD), Some("Private"), None).is_err());
        assert!(store_from(Some(ONEPASSWORD), None, Some("Yarvis")).is_err());
        assert!(store_from(Some(ONEPASSWORD), Some("Private"), Some("Yarvis")).is_ok());
    }
}
