//! Passkeys: the WebAuthn relying party, the stored credentials, the setup
//! code, and the ceremonies in flight between a `start` and its `finish`.
//!
//! Stored passkeys hold only public keys and sign counts, so they live in the
//! server's SQLite like devices. Ceremony state stays in memory with a short
//! expiry: a restart only costs a client its current prompt.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

use rusqlite::OptionalExtension;
use webauthn_rs::prelude::{
    AuthenticationResult, CreationChallengeResponse, Passkey, PasskeyAuthentication,
    PasskeyRegistration, RequestChallengeResponse, Url, Uuid, Webauthn, WebauthnBuilder,
    WebauthnError,
};

use super::new_id;
use super::setup_code::{CodeError, CodeHash, SetupCode};
use crate::config::AuthConfig;
use crate::error::{ApiError, ApiResult};
use crate::store::{Store, StoreError, now_ms};

/// One user per server. A multi-user build gives each user their own handle.
const USER_ID: Uuid = Uuid::from_u128(0x6f1d2b3c_0000_4000_8000_0000000000a1);

/// How long a ceremony may sit between start and finish.
const CEREMONY_TTL: Duration = Duration::from_secs(300);

/// Setup and sign-in ceremonies in flight at once. Starting one needs no
/// token, so the map needs a bound. At the bound the oldest is dropped rather
/// than new ones refused: a flood then has to outpace the owner's own prompt,
/// instead of only having to fill the map once.
const MAX_OPEN_CEREMONIES: usize = 256;

/// Ceremonies started by signed-in devices, which a flood of the open routes
/// can't crowd out. Only a valid admin token can start one.
const MAX_SIGNED_IN_CEREMONIES: usize = 64;

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("auth.origins is empty; list the origins a browser signs in from")]
    NoOrigins,
    #[error("auth.origins has an invalid URL {0:?}")]
    BadOrigin(String),
    #[error("auth.rp_id {rp_id:?} doesn't fit the origins: {source}")]
    Webauthn {
        rp_id: String,
        source: WebauthnError,
    },
}

/// What a ceremony remembers between its start and its finish.
pub enum Ceremony {
    Setup {
        reg: PasskeyRegistration,
        code: CodeHash,
        device_name: String,
    },
    AddPasskey {
        reg: PasskeyRegistration,
        device_id: String,
        label: String,
    },
    Login {
        auth: PasskeyAuthentication,
    },
    Reverify {
        auth: PasskeyAuthentication,
        device_id: String,
    },
}

impl Ceremony {
    /// Started by a route that needs no token.
    fn is_open(&self) -> bool {
        matches!(self, Ceremony::Setup { .. } | Ceremony::Login { .. })
    }
}

#[derive(Debug, thiserror::Error)]
pub enum SetupCodeError {
    #[error(transparent)]
    Store(#[from] StoreError),
    #[error("couldn't write the setup code file: {0}")]
    File(#[from] std::io::Error),
}

pub enum RemovePasskey {
    /// Carries the ids of the devices that were revoked with it.
    Removed {
        revoked: Vec<String>,
    },
    LastOne,
    NotFound,
}

#[derive(Clone)]
pub struct PasskeyRecord {
    pub id: String,
    pub label: String,
    pub created_at: i64,
    pub passkey: Passkey,
}

#[derive(Clone)]
pub struct PasskeyAuth(Arc<Inner>);

struct Inner {
    webauthn: Webauthn,
    rp_id: String,
    store: Store,
    setup_code: Mutex<SetupCode>,
    setup_code_file: Mutex<Option<PathBuf>>,
    ceremonies: Mutex<HashMap<String, (Instant, Ceremony)>>,
}

impl PasskeyAuth {
    pub fn new(config: &AuthConfig, store: Store) -> Result<Self, ConfigError> {
        Ok(Self(Arc::new(Inner {
            webauthn: build_webauthn(config)?,
            rp_id: config.rp_id.clone(),
            store,
            setup_code: Mutex::default(),
            setup_code_file: Mutex::default(),
            ceremonies: Mutex::default(),
        })))
    }

    /// The relying party, for modules that run passkey ceremonies of their
    /// own against the same passkeys.
    pub fn webauthn(&self) -> &Webauthn {
        &self.0.webauthn
    }

    pub fn rp_id(&self) -> &str {
        &self.0.rp_id
    }

    /// Issues the setup code when no passkey exists yet. The caller prints it
    /// to stdout, never a log. With `file`, the code is also written there,
    /// readable only by the owner, for a server whose stdout goes to a log
    /// file; the file is deleted once the code is used. A file left by an
    /// earlier run is deleted when no code is needed.
    pub async fn issue_setup_code_if_needed(
        &self,
        file: Option<&Path>,
    ) -> Result<Option<String>, SetupCodeError> {
        if let Some(file) = file {
            remove_if_present(file)?;
        }
        if !self.setup_required().await? {
            return Ok(None);
        }
        let code = lock(&self.0.setup_code).issue();
        if let Some(file) = file {
            write_private(file, &format!("{code}\n"))?;
            *lock(&self.0.setup_code_file) = Some(file.to_path_buf());
        }
        Ok(Some(code))
    }

    pub fn check_setup_code(&self, given: &str) -> Result<CodeHash, CodeError> {
        lock(&self.0.setup_code).check(given)
    }

    /// Uses the code up and deletes its file.
    pub fn consume_setup_code(&self, code: &CodeHash) -> bool {
        if !lock(&self.0.setup_code).consume(code) {
            return false;
        }
        if let Some(file) = lock(&self.0.setup_code_file).take()
            && let Err(e) = remove_if_present(&file)
        {
            tracing::warn!("couldn't delete the used setup code file: {e}");
        }
        true
    }

    pub async fn setup_required(&self) -> Result<bool, StoreError> {
        self.0
            .store
            .call(|conn| {
                conn.query_row("SELECT NOT EXISTS (SELECT 1 FROM passkeys)", [], |row| {
                    row.get(0)
                })
            })
            .await
    }

    // ---- ceremonies ----

    /// Stores a ceremony and returns its id. Returns `None` when too many
    /// signed-in ceremonies are in flight; open ones push out the oldest.
    pub fn start_ceremony(&self, ceremony: Ceremony) -> Option<String> {
        let mut ceremonies = lock(&self.0.ceremonies);
        ceremonies.retain(|_, (at, _)| at.elapsed() < CEREMONY_TTL);
        let open = ceremony.is_open();
        let same_kind = ceremonies.values().filter(|(_, c)| c.is_open() == open);
        if open {
            if same_kind.count() >= MAX_OPEN_CEREMONIES {
                let oldest = ceremonies
                    .iter()
                    .filter(|(_, (_, c))| c.is_open())
                    .min_by_key(|(_, (at, _))| *at)
                    .map(|(id, _)| id.clone());
                if let Some(oldest) = oldest {
                    ceremonies.remove(&oldest);
                }
            }
        } else if same_kind.count() >= MAX_SIGNED_IN_CEREMONIES {
            return None;
        }
        let id = new_id();
        ceremonies.insert(id.clone(), (Instant::now(), ceremony));
        Some(id)
    }

    /// Takes the ceremony out, so its challenge can be answered only once.
    pub fn take_ceremony(&self, id: &str) -> Option<Ceremony> {
        let (at, ceremony) = lock(&self.0.ceremonies).remove(id)?;
        (at.elapsed() < CEREMONY_TTL).then_some(ceremony)
    }

    /// Registration options that refuse an authenticator already holding one
    /// of this server's passkeys.
    pub async fn start_registration(
        &self,
    ) -> ApiResult<(CreationChallengeResponse, PasskeyRegistration)> {
        let exclude = self
            .passkeys()
            .await?
            .into_iter()
            .map(|p| p.passkey.cred_id().clone())
            .collect();
        self.0
            .webauthn
            .start_passkey_registration(USER_ID, "yarvis", "Yarvis", Some(exclude))
            .map_err(ApiError::internal)
    }

    /// Assertion options offering every stored passkey.
    pub async fn start_assertion(
        &self,
    ) -> ApiResult<(RequestChallengeResponse, PasskeyAuthentication)> {
        let passkeys: Vec<Passkey> = self
            .passkeys()
            .await?
            .into_iter()
            .map(|p| p.passkey)
            .collect();
        if passkeys.is_empty() {
            return Err(ApiError::conflict(
                "no passkey is registered yet; finish setup first",
            ));
        }
        self.0
            .webauthn
            .start_passkey_authentication(&passkeys)
            .map_err(ApiError::internal)
    }

    // ---- stored passkeys ----

    pub async fn passkeys(&self) -> Result<Vec<PasskeyRecord>, StoreError> {
        self.0
            .store
            .call(|conn| {
                let mut stmt = conn.prepare(
                    "SELECT id, label, created_at, passkey FROM passkeys ORDER BY created_at",
                )?;
                let rows = stmt.query_map([], read_record)?;
                rows.collect()
            })
            .await
    }

    /// The passkey a credential id names, as an assertion reports it.
    pub async fn passkey_by_credential_id(
        &self,
        credential_id: &[u8],
    ) -> Result<Option<PasskeyRecord>, StoreError> {
        let credential_id = credential_id.to_vec();
        self.0
            .store
            .call(move |conn| {
                conn.query_row(
                    "SELECT id, label, created_at, passkey FROM passkeys WHERE credential_id = ?1",
                    [credential_id],
                    read_record,
                )
                .optional()
            })
            .await
    }

    /// Stores a newly registered passkey and returns its id.
    pub async fn add_passkey(&self, label: &str, passkey: Passkey) -> Result<String, StoreError> {
        let id = new_id();
        let (row_id, label) = (id.clone(), label.to_string());
        self.0
            .store
            .call(move |conn| {
                conn.execute(
                    "INSERT INTO passkeys (id, credential_id, label, passkey, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                    rusqlite::params![
                        row_id,
                        passkey.cred_id().as_slice(),
                        label,
                        to_json(&passkey)?,
                        now_ms()
                    ],
                )
            })
            .await?;
        Ok(id)
    }

    /// Deletes a passkey and revokes every device it signed in, which is what
    /// a compromised passkey calls for. The last passkey is never removed,
    /// since nothing could sign in after it.
    pub async fn remove_passkey(&self, id: &str) -> Result<RemovePasskey, StoreError> {
        let id = id.to_string();
        self.0
            .store
            .call(move |conn| {
                let tx = conn.transaction()?;
                let (exists, total): (bool, i64) = tx.query_row(
                    "SELECT EXISTS (SELECT 1 FROM passkeys WHERE id = ?1), COUNT(*) FROM passkeys",
                    [&id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )?;
                if !exists {
                    return Ok(RemovePasskey::NotFound);
                }
                if total == 1 {
                    return Ok(RemovePasskey::LastOne);
                }
                let revoked = {
                    let mut stmt = tx.prepare(
                        "SELECT id FROM devices WHERE passkey_id = ?1 AND revoked_at IS NULL",
                    )?;
                    stmt.query_map([&id], |row| row.get(0))?
                        .collect::<rusqlite::Result<Vec<String>>>()?
                };
                tx.execute(
                    "UPDATE devices SET revoked_at = ?1 WHERE passkey_id = ?2 AND revoked_at IS NULL",
                    rusqlite::params![now_ms(), id],
                )?;
                tx.execute("DELETE FROM passkeys WHERE id = ?1", [&id])?;
                tx.commit()?;
                Ok(RemovePasskey::Removed { revoked })
            })
            .await
    }

    /// Records a verified assertion: the new sign count and when the passkey
    /// was last used. Returns the passkey's id, or `None` if it was removed
    /// while the ceremony was open.
    pub async fn record_use(
        &self,
        result: &AuthenticationResult,
    ) -> Result<Option<String>, StoreError> {
        let result = result.clone();
        self.0
            .store
            .call(move |conn| {
                let tx = conn.transaction()?;
                let found = tx
                    .query_row(
                        "SELECT id, label, created_at, passkey FROM passkeys WHERE credential_id = ?1",
                        [result.cred_id().as_slice()],
                        read_record,
                    )
                    .optional()?;
                let Some(mut record) = found else {
                    return Ok(None);
                };
                record.passkey.update_credential(&result);
                tx.execute(
                    "UPDATE passkeys SET passkey = ?1, last_used_at = ?2 WHERE id = ?3",
                    rusqlite::params![to_json(&record.passkey)?, now_ms(), record.id],
                )?;
                tx.commit()?;
                Ok(Some(record.id))
            })
            .await
    }
}

fn remove_if_present(path: &Path) -> std::io::Result<()> {
    match std::fs::remove_file(path) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e),
        _ => Ok(()),
    }
}

/// Creates the file fresh with mode 0600, so it is never readable by others,
/// even for a moment.
fn write_private(path: &Path, text: &str) -> std::io::Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o600);
    options.open(path)?.write_all(text.as_bytes())
}

fn build_webauthn(config: &AuthConfig) -> Result<Webauthn, ConfigError> {
    let mut origins = config
        .origins
        .iter()
        .map(|origin| Url::parse(origin).map_err(|_| ConfigError::BadOrigin(origin.clone())));
    let first = origins.next().ok_or(ConfigError::NoOrigins)??;
    let webauthn_error = |source| ConfigError::Webauthn {
        rp_id: config.rp_id.clone(),
        source,
    };
    let mut builder = WebauthnBuilder::new(&config.rp_id, &first)
        .map_err(webauthn_error)?
        .rp_name("Yarvis");
    for origin in origins {
        builder = builder.append_allowed_origin(&origin?);
    }
    builder.build().map_err(webauthn_error)
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<PasskeyRecord> {
    let json: String = row.get(3)?;
    let passkey = serde_json::from_str(&json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, e.into())
    })?;
    Ok(PasskeyRecord {
        id: row.get(0)?,
        label: row.get(1)?,
        created_at: row.get(2)?,
        passkey,
    })
}

fn to_json(passkey: &Passkey) -> rusqlite::Result<String> {
    serde_json::to_string(passkey).map_err(|e| rusqlite::Error::ToSqlConversionFailure(e.into()))
}

/// The guarded maps hold no invariant a panic could break halfway, so a
/// poisoned lock is still usable.
fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_rp_id_unrelated_to_the_origin_is_refused_at_startup() {
        let config = AuthConfig {
            rp_id: "example.com".into(),
            origins: vec!["https://yarvis.other.net".into()],
        };
        let Err(err) = build_webauthn(&config) else {
            panic!("an unrelated RP ID was accepted");
        };
        assert!(matches!(err, ConfigError::Webauthn { .. }), "{err}");
    }

    #[test]
    fn every_listed_origin_is_accepted() {
        let config = AuthConfig {
            rp_id: "example.com".into(),
            origins: vec![
                "https://yarvis.example.com".into(),
                "https://example.com".into(),
            ],
        };
        build_webauthn(&config).unwrap();
        let none = AuthConfig {
            rp_id: "example.com".into(),
            origins: vec![],
        };
        assert!(matches!(build_webauthn(&none), Err(ConfigError::NoOrigins)));
    }
}
