//! Where the server finds its Postgres database. The URL is needed at boot,
//! before anyone can sign in or unlock the vault, so it comes from the
//! environment or `server.toml` rather than the secret store. The server hands
//! it to the sidecar, which uses the same database.
//!
//! With the Keychain or 1Password backend, a `database_url` saved in the
//! secrets blob is the fallback when neither names a database. The vault is
//! locked at boot, so it is never read there. A secret store that can't be
//! read stops the server rather than counting as empty: the default database
//! may hold another account, or none, and the server would sign people in
//! against the wrong one.
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
/// [`DEFAULT_URL`]. Fails only when `legacy` does.
pub fn resolve(
    config: &Config,
    env: Option<String>,
    legacy: impl FnOnce() -> Result<Option<String>, String>,
) -> Result<DatabaseUrl, String> {
    let non_blank = |url: Option<String>| url.filter(|u| !u.trim().is_empty());
    let (url, source) = if let Some(url) = non_blank(env) {
        (url, UrlSource::Env)
    } else if let Some(url) = non_blank(config.database.url.clone()) {
        (url, UrlSource::ConfigFile)
    } else if config.secrets.backend == Some(SecretBackendKind::Vault) {
        (DEFAULT_URL.to_string(), UrlSource::Default)
    } else if let Some(url) = non_blank(legacy()?) {
        (url, UrlSource::SecretStore)
    } else {
        (DEFAULT_URL.to_string(), UrlSource::Default)
    };
    Ok(DatabaseUrl { url, source })
}

/// Reads `YARVIS_DATABASE_URL`.
pub fn from_env() -> Option<String> {
    std::env::var(ENV_VAR).ok()
}

/// The `database_url` saved in the Keychain or 1Password item, if any.
pub fn from_legacy_secret_store(config: &Config) -> Result<Option<String>, String> {
    let settings =
        crate::settings::SettingsStore::new(crate::settings::SettingsStore::default_path());
    let vault = crate::vault::Vault::new(&config.server.data_dir);
    let blob =
        crate::secret_blob::SecretBlob::from_config(config.secrets.backend, settings, &vault);
    let root = blob.read_root().map_err(|e| {
        format!(
            "{e}, which may hold the database URL. Set {ENV_VAR}, or `url` under [database] in \
             server.toml, so the server doesn't need it"
        )
    })?;
    Ok(crate::secret_blob::secret_from_root(
        &root,
        LEGACY_SECRET_KEY,
    ))
}

/// Replaces the password in a URL's userinfo, and any query value whose key
/// mentions a password, with `****`. The fragment is dropped, since an
/// unencoded `#` in a password puts the rest of it there. A string that
/// doesn't parse is hidden entirely.
pub fn mask(raw: &str) -> String {
    let Ok(mut url) = url::Url::parse(raw) else {
        return "****".into();
    };
    url.set_fragment(None);
    if url.password().is_some() {
        let _ = url.set_password(Some("****"));
    }
    if url.query().is_some() {
        let pairs: Vec<(String, String)> = url
            .query_pairs()
            .map(|(k, v)| {
                let v = if k.to_ascii_lowercase().contains("pass") {
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
        let legacy = || Ok(Some("postgres://legacy".to_string()));
        let both = config(Some("postgres://file"), None);
        let picked = resolve(&both, Some("postgres://env".into()), legacy).unwrap();
        assert_eq!(
            (picked.url.as_str(), picked.source),
            ("postgres://env", UrlSource::Env)
        );
        let picked = resolve(&both, None, legacy).unwrap();
        assert_eq!(picked.source, UrlSource::ConfigFile);
        let picked = resolve(&config(Some(" "), None), Some(" ".into()), legacy).unwrap();
        assert_eq!(
            (picked.url.as_str(), picked.source),
            ("postgres://legacy", UrlSource::SecretStore)
        );
    }

    #[test]
    fn the_secret_store_is_only_read_when_nothing_else_names_a_database() {
        let picked = resolve(&config(Some("postgres://file"), None), None, || {
            panic!("read the secret store")
        })
        .unwrap();
        assert_eq!(picked.source, UrlSource::ConfigFile);
    }

    #[test]
    fn a_vault_install_never_reads_the_secret_store_and_gets_the_default() {
        let picked = resolve(&config(None, Some(SecretBackendKind::Vault)), None, || {
            panic!("the vault is locked at boot")
        })
        .unwrap();
        assert_eq!(
            (picked.url.as_str(), picked.source),
            (DEFAULT_URL, UrlSource::Default)
        );
    }

    #[test]
    fn with_nothing_set_the_default_is_used() {
        let picked = resolve(&config(None, None), None, || Ok(None)).unwrap();
        assert_eq!(picked.source, UrlSource::Default);
    }

    #[test]
    fn a_secret_store_that_cant_be_read_stops_the_server_rather_than_using_the_default() {
        let err = resolve(&config(None, None), None, || {
            Err("1Password is locked".into())
        })
        .unwrap_err();
        assert!(err.contains("locked"), "{err}");
    }

    #[test]
    fn sources_serialize_as_the_settings_screen_expects() {
        // `DATABASE_SOURCE_TEXT` in src/lib/database.ts is keyed on these.
        let names: Vec<_> = [
            UrlSource::Env,
            UrlSource::ConfigFile,
            UrlSource::SecretStore,
            UrlSource::Default,
        ]
        .iter()
        .map(|s| serde_json::to_value(s).unwrap())
        .collect();
        assert_eq!(
            names,
            ["env", "configFile", "secretStore", "default"].map(serde_json::Value::from)
        );
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
        assert_eq!(
            mask("postgres://localhost/y?sslpassword=s3cret"),
            "postgres://localhost/y?sslpassword=****"
        );
        assert!(!mask("postgres://me:pa#ss3cret@host/db").contains("ss3cret"));
        let url = DatabaseUrl {
            url: "postgres://me:s3cret@x/y".into(),
            source: UrlSource::Env,
        };
        assert!(!format!("{url:?}").contains("s3cret"));
    }
}
