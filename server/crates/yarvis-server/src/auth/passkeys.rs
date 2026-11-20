//! Passkeys: the WebAuthn relying party, the stored credentials, the setup
//! code, and the ceremonies in flight between a `start` and its `finish`.
//!
//! Stored passkeys hold only public keys and sign counts, so they live in the
//! server's SQLite like devices. Ceremony state stays in memory with a short
//! expiry: a restart only costs a client its current prompt.

use std::collections::HashMap;
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

/// Ceremonies in flight at once. Starting one needs no token, so without a
/// cap anyone who can reach the port could grow this map without limit.
const MAX_CEREMONIES: usize = 256;

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
    ceremonies: Mutex<HashMap<String, (Instant, Ceremony)>>,
}

impl PasskeyAuth {
    pub fn new(config: &AuthConfig, store: Store) -> Result<Self, ConfigError> {
        Ok(Self(Arc::new(Inner {
            webauthn: build_webauthn(config)?,
            rp_id: config.rp_id.clone(),
            store,
            setup_code: Mutex::default(),
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
    /// where only the server's operator sees it: stdout, never a log.
    pub async fn issue_setup_code_if_needed(&self) -> Result<Option<String>, StoreError> {
        if !self.setup_required().await? {
            return Ok(None);
        }
        Ok(Some(lock(&self.0.setup_code).issue()))
    }

    pub fn check_setup_code(&self, given: &str) -> Result<CodeHash, CodeError> {
        lock(&self.0.setup_code).check(given)
    }

    pub fn consume_setup_code(&self, code: &CodeHash) -> bool {
        lock(&self.0.setup_code).consume(code)
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

    /// Stores a ceremony and returns its id, or `None` when too many are
    /// already in flight.
    pub fn start_ceremony(&self, ceremony: Ceremony) -> Option<String> {
        let mut ceremonies = lock(&self.0.ceremonies);
        ceremonies.retain(|_, (at, _)| at.elapsed() < CEREMONY_TTL);
        if ceremonies.len() >= MAX_CEREMONIES {
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
