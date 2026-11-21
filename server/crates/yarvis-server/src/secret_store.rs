//! Where the secrets blob lives.
//!
//! The blob is one JSON object, the same one `src-tauri`'s `keychain.rs`
//! reads and writes today, so moving between backends is a copy. What the
//! blob contains is the business of the code above this trait. A backend only
//! stores the bytes.
//!
//! The invariant from `src-tauri`: a read that fails must never look like an
//! empty store, or the read-modify-write above it would replace every secret
//! with one. So `read_root` returns `Ok(None)` only when there is truly
//! nothing stored, and an error for anything else, including "locked".

#[derive(Debug, thiserror::Error)]
pub enum SecretError {
    /// The vault is locked. Unlock it and try again.
    #[error("the vault is locked")]
    Locked,
    #[error("{0}")]
    Backend(String),
}

pub trait SecretBackend: Send + Sync {
    /// The stored blob, or `None` when nothing has ever been stored.
    fn read_root(&self) -> Result<Option<String>, SecretError>;

    /// Replaces the stored blob. Callers serialize writes, since every write is
    /// a read-modify-write of the one blob.
    fn write_root(&self, blob: &str) -> Result<(), SecretError>;
}

pub mod keychain;
pub mod memory;
pub mod onepassword;
