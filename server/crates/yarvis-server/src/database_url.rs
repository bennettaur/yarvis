//! Where the server finds its Postgres database. The URL is needed at boot,
//! before anyone can sign in or unlock the vault, so it comes from the
//! environment or `server.toml` rather than the secret store. The server hands
//! it to the sidecar, which uses the same database.
//!
//! Installs from before this kept it in the secret store as `database_url`.
//! With the Keychain or 1Password, that copy is still read when nothing else
//! names a database, so an existing install keeps working until the URL is
//! moved. The vault is locked at boot, so it is never read there.
//!
//! With none of these, the server uses [`DEFAULT_URL`], the database the
//! getting-started guide creates, so a fresh install works with no setup.

use serde::Serialize;

use crate::config::{Config, SecretBackendKind};

pub const ENV_VAR: &str = "YARVIS_DATABASE_URL";

/// The database `mise run yarvis-init` and the getting-started guide create.
pub const DEFAULT_URL: &str = "postgres://localhost:5432/yarvis";

/// The secrets-blob key older installs kept the URL under.
pub const LEGACY_SECRET_KEY: &str = "database_url";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum UrlSource {
    /// `YARVIS_DATABASE_URL`.
    Env,
    /// `[database] url` in `server.toml`.
    ConfigFile,
    /// `database_url` in the Keychain or 1Password item.
    SecretStore,
    /// None of them was set, so [`DEFAULT_URL`].
    Default,
}

#[derive(Clone)]
pub struct DatabaseUrl {
    pub url: String,
    pub source: UrlSource,
}

// By hand, so the password never reaches a log through `{:?}`.
impl std::fmt::Debug for DatabaseUrl {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatabaseUrl")
            .field("url", &mask(&self.url))
            .field("source", &self.source)
            .finish()
    }
}

impl DatabaseUrl {
    /// The URL with any password replaced, safe to show or log.
    pub fn masked(&self) -> String {
        mask(&self.url)
    }
}

/// Picks the URL: the env var, then `server.toml`, then `legacy`, which reads
/// the secret store and is only called when the first two are unset, then
/// [`DEFAULT_URL`].
pub fn resolve(
    config: &Config,
    env: Option<String>,
    legacy: impl FnOnce() -> Option<String>,
) -> DatabaseUrl {
    let given = |url: Option<String>| url.filter(|u| !u.trim().is_empty());
    let (url, source) = if let Some(url) = given(env) {
        (url, UrlSource::Env)
    } else if let Some(url) = given(config.database.url.clone()) {
        (url, UrlSource::ConfigFile)
    } else if let Some(url) = (config.secrets.backend != Some(SecretBackendKind::Vault))
        .then(legacy)
        .and_then(given)
    {
        (url, UrlSource::SecretStore)
    } else {
        (DEFAULT_URL.to_string(), UrlSource::Default)
    };
    DatabaseUrl { url, source }
}

/// Reads `YARVIS_DATABASE_URL`.
pub fn from_env() -> Option<String> {
    std::env::var(ENV_VAR).ok()
}

/// The URL an older install saved in the Keychain or 1Password, if any. A
/// failed read counts as none, and is logged.
pub fn from_legacy_secret_store(config: &Config) -> Option<String> {
    let settings =
        crate::settings::SettingsStore::new(crate::settings::SettingsStore::default_path());
    let vault = crate::vault::Vault::new(&config.server.data_dir);
    let blob =
        crate::secret_blob::SecretBlob::from_config(config.secrets.backend, settings, &vault);
    match blob.read_root() {
        Ok(root) => crate::secret_blob::secret_from_root(&root, LEGACY_SECRET_KEY),
        Err(e) => {
            tracing::warn!("couldn't read the secret store for a saved database URL: {e}");
            None
        }
    }
}

/// Replaces the password in a URL's userinfo, and any `password=` query
/// value, with `****`. A string that doesn't parse is hidden entirely.
pub fn mask(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "****".into();
    };
    if url.password().is_some() {
        let _ = url.set_password(Some("****"));
    }
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let v = if k.eq_ignore_ascii_case("password") {
                    "****".to_string()
                } else {
                    v.into_owned()
                };
                (k.into_owned(), v)
            })
            .collect();
        url.query_pairs_mut().clear().extend_pairs(pairs);
    }
    url.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn config(url: Option<&str>, backend: Option<SecretBackendKind>) -> Config {
        let mut config = Config::default();
        config.database.url = url.map(str::to_string);
        config.secrets.backend = backend;
        config
    }

    #[test]
    fn the_env_var_beats_the_config_file_which_beats_the_secret_store() {
        let legacy = || Some("postgres://legacy".to_string());
        let both = config(Some("postgres://file"), None);
        let picked = resolve(&both, Some("postgres://env".into()), legacy);
        assert_eq!(
            (picked.url.as_str(), picked.source),
            ("postgres://env", UrlSource::Env)
        );
        let picked = resolve(&both, None, legacy);
        assert_eq!(picked.source, UrlSource::ConfigFile);
        let picked = resolve(&config(None, None), Some(" ".into()), legacy);
        assert_eq!(
            (picked.url.as_str(), picked.source),
            ("postgres://legacy", UrlSource::SecretStore)
        );
    }

    #[test]
    fn the_secret_store_is_only_read_when_nothing_else_names_a_database() {
        let picked = resolve(&config(Some("postgres://file"), None), None, || {
            panic!("read the secret store")
        });
        assert_eq!(picked.source, UrlSource::ConfigFile);
    }

    #[test]
    fn a_vault_install_never_reads_the_secret_store_and_gets_the_default() {
        let picked = resolve(&config(None, Some(SecretBackendKind::Vault)), None, || {
            panic!("the vault is locked at boot")
        });
        assert_eq!(
            (picked.url.as_str(), picked.source),
            (DEFAULT_URL, UrlSource::Default)
        );
    }

    #[test]
    fn with_nothing_set_the_default_is_used() {
        let picked = resolve(&config(None, None), None, || None);
        assert_eq!(picked.source, UrlSource::Default);
    }

    #[test]
    fn a_password_never_shows() {
        assert_eq!(
            mask("postgres://me:s3cret@db.example:5432/yarvis"),
            "postgres://me:****@db.example:5432/yarvis"
        );
        assert_eq!(
            mask("postgres://localhost/yarvis?sslmode=require&password=s3cret"),
            "postgres://localhost/yarvis?sslmode=require&password=****"
        );
        assert_eq!(
            mask("postgres://localhost:5432/yarvis"),
            "postgres://localhost:5432/yarvis"
        );
        assert_eq!(mask("not a url with s3cret"), "****");
        let url = DatabaseUrl {
            url: "postgres://me:s3cret@x/y".into(),
            source: UrlSource::Env,
        };
        assert!(!format!("{url:?}").contains("s3cret"));
    }
}
