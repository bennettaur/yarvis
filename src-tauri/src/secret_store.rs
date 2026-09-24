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
    /// An in-process store, for tests. Neither real backend can be made to
    /// fail on demand, and the rules that matter most here — never write on a
    /// failed read, never overwrite an occupied target — are only observable
    /// when a store *can* fail. See [`MemoryStore`].
    #[cfg(test)]
    Memory(std::sync::Arc<MemoryStore>),
}

/// A fake store that records its writes and can be told to fail.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct MemoryStore {
    blob: std::sync::Mutex<Option<String>>,
    /// Every blob handed to [`Store::write`], in order.
    writes: std::sync::Mutex<Vec<String>>,
    read_fails: bool,
    write_fails: bool,
}

#[cfg(test)]
impl MemoryStore {
    pub fn empty() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self::default())
    }

    pub fn holding(blob: &str) -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            blob: std::sync::Mutex::new(Some(blob.to_string())),
            ..Self::default()
        })
    }

    pub fn unreadable() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            read_fails: true,
            ..Self::default()
        })
    }

    pub fn unwritable() -> std::sync::Arc<Self> {
        std::sync::Arc::new(Self {
            write_fails: true,
            ..Self::default()
        })
    }

    pub fn contents(&self) -> Option<String> {
        self.blob.lock().unwrap().clone()
    }

    pub fn writes(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }
}

/// Two fakes are the same store only if they are the same object, so a test
/// holding both a source and a target never has them compare equal.
#[cfg(test)]
impl PartialEq for MemoryStore {
    fn eq(&self, other: &Self) -> bool {
        std::ptr::eq(self, other)
    }
}

#[cfg(test)]
impl Eq for MemoryStore {}

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
            #[cfg(test)]
            Self::Memory(store) => {
                if store.read_fails {
                    return Err("the fake store is unreadable".to_string());
                }
                Ok(store.contents())
            }
        }
    }

    pub fn write(&self, blob: &str) -> Result<(), String> {
        match self {
            Self::Keychain => keychain_entry()?
                .set_password(blob)
                .map_err(|e| e.to_string()),
            Self::OnePassword(item) => onepassword::write_blob(item, blob),
            #[cfg(test)]
            Self::Memory(store) => {
                if store.write_fails {
                    return Err("the fake store is unwritable".to_string());
                }
                store.writes.lock().unwrap().push(blob.to_string());
                *store.blob.lock().unwrap() = Some(blob.to_string());
                Ok(())
            }
        }
    }

    /// The `settings.secretBackend` value that selects this store, or `None`
    /// for the default. Paired with [`store_from`] so a round trip through
    /// settings lands on the same store.
    pub fn backend_setting(&self) -> Option<&'static str> {
        match self {
            Self::OnePassword(_) => Some(ONEPASSWORD),
            #[cfg(test)]
            Self::Memory(_) => None,
            Self::Keychain => None,
        }
    }

    /// How the store names itself in an error the user reads.
    pub fn label(&self) -> &'static str {
        match self {
            Self::Keychain => "the macOS Keychain",
            Self::OnePassword(_) => "1Password",
            #[cfg(test)]
            Self::Memory(_) => "the fake store",
        }
    }
}

fn keychain_entry() -> Result<Entry, String> {
    Entry::new(SERVICE, SECRETS_ACCOUNT).map_err(|e| e.to_string())
}

/// Builds the store described by `backend`/`vault`/`item`, rejecting a
/// 1Password selection that is missing either part. Shared by the settings
/// validation and the live lookup below so the two cannot disagree.
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
    .unwrap_or_else(|e| {
        // Falling back silently would have the app read *and write* the
        // Keychain while Settings still shows 1Password, which is not
        // something the user could work out unaided.
        eprintln!("[secrets] unusable 1Password selection, using the Keychain: {e}");
        Store::Keychain
    })
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
