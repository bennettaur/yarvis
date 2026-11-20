//! An in-process backend that records its writes and can be told to fail.
//!
//! Neither real backend can be made to fail on demand, and the rules that
//! matter most for the secrets blob (never write on a failed read, never
//! overwrite an occupied target) are only observable when a store can fail.
//! Public rather than `cfg(test)` so the integration tests under `tests/` can
//! build a server on it.

use std::sync::{Arc, Mutex};

use super::{SecretBackend, SecretError};

#[derive(Debug, Default)]
pub struct MemoryBackend {
    blob: Mutex<Option<String>>,
    writes: Mutex<Vec<String>>,
    read_fails: bool,
    write_fails: bool,
}

impl MemoryBackend {
    pub fn empty() -> Arc<Self> {
        Arc::new(Self::default())
    }

    pub fn holding(blob: &str) -> Arc<Self> {
        Arc::new(Self {
            blob: Mutex::new(Some(blob.to_string())),
            ..Self::default()
        })
    }

    pub fn unreadable() -> Arc<Self> {
        Arc::new(Self {
            read_fails: true,
            ..Self::default()
        })
    }

    pub fn unwritable() -> Arc<Self> {
        Arc::new(Self {
            write_fails: true,
            ..Self::default()
        })
    }

    /// Holds `blob` but refuses every write.
    pub fn read_only(blob: &str) -> Arc<Self> {
        Arc::new(Self {
            blob: Mutex::new(Some(blob.to_string())),
            write_fails: true,
            ..Self::default()
        })
    }

    pub fn contents(&self) -> Option<String> {
        self.blob.lock().unwrap().clone()
    }

    /// Every blob handed to `write_root`, in order.
    pub fn writes(&self) -> Vec<String> {
        self.writes.lock().unwrap().clone()
    }
}

impl SecretBackend for MemoryBackend {
    fn read_root(&self) -> Result<Option<String>, SecretError> {
        if self.read_fails {
            return Err(SecretError::Backend("the fake store is unreadable".into()));
        }
        Ok(self.contents())
    }

    fn write_root(&self, blob: &str) -> Result<(), SecretError> {
        if self.write_fails {
            return Err(SecretError::Backend("the fake store is unwritable".into()));
        }
        self.writes.lock().unwrap().push(blob.to_string());
        *self.blob.lock().unwrap() = Some(blob.to_string());
        Ok(())
    }
}
