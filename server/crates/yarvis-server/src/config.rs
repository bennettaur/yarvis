//! The server's config file (`server.toml`).
//!
//! Every field has a default, so an empty file (or no file) gives a server on
//! 127.0.0.1 that keeps secrets wherever the desktop app's settings say (the
//! macOS Keychain unless they name 1Password) and runs no ssh-agent: the same
//! behavior as the desktop app.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub auth: AuthConfig,
    pub secrets: SecretsConfig,
    pub ssh_agent: SshAgentConfig,
    pub sidecar: SidecarConfig,
    pub database: DatabaseConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Loopback by default. Binding a LAN or tailnet address is a deliberate
    /// choice, since it is what makes the server reachable from other machines.
    pub bind: SocketAddr,
    /// Where the server keeps the setup code, its sockets and, with the vault
    /// backend, the vault file.
    pub data_dir: PathBuf,
    /// The built web UI (`dist/`). Unset means the server serves only `/api`.
    pub web_dir: Option<PathBuf>,
    /// The server speaks plain HTTP. Binding anything but loopback sends
    /// tokens in the clear, so it is refused unless this is set, which is
    /// for a server behind something that adds TLS, such as `tailscale serve`.
    pub allow_plain_http: bool,
    /// The `PATH` the server gives the processes it starts: the sidecar, and
    /// the terminal and agent sessions. Unset means they inherit the server's
    /// own. A server started by launchd gets launchd's short `PATH`, which
    /// misses Homebrew and mise, so `claude`, `git`, `gh` and `bun` aren't
    /// found without this.
    pub path: Option<String>,
    /// Where the control and ssh-agent sockets go. Unset means the data dir,
    /// or `~/.yarvis/run/<hash>` when a socket path there would be too long
    /// for a Unix socket (`socket_dir.rs`). Must be absolute.
    pub socket_dir: Option<PathBuf>,
}

impl ServerConfig {
    /// [`Self::path`], with a blank value read as unset.
    pub fn spawn_path(&self) -> Option<&str> {
        self.path
            .as_deref()
            .map(str::trim)
            .filter(|p| !p.is_empty())
    }
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 7878)),
            data_dir: default_data_dir(),
            web_dir: None,
            allow_plain_http: false,
            path: None,
            socket_dir: None,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    /// The origins clients reach the server on, such as
    /// `https://mini.example.ts.net`. Requests for any other host are refused,
    /// and the first `https` one off loopback is where OAuth redirects land.
    pub origins: Vec<String>,
}

impl AuthConfig {
    /// The origin other machines reach this server on: the first `https`
    /// origin that isn't loopback, such as a `tailscale serve` name. OAuth
    /// redirects go there, so they work from a browser anywhere. `None` for a
    /// server only reached on loopback.
    /// Written as a browser would serialize it (lowercase host, no `:443`),
    /// which is what an OAuth provider compares a redirect against. An origin
    /// with userinfo, a path or a query isn't one, and is skipped.
    pub fn public_origin(&self) -> Option<String> {
        self.origins.iter().find_map(|origin| {
            let uri: axum::http::Uri = origin.parse().ok()?;
            let authority = uri.authority()?;
            let plain = uri.scheme_str() == Some("https")
                && !authority.as_str().contains('@')
                && matches!(uri.path(), "" | "/")
                && uri.query().is_none();
            let host = authority.host().to_ascii_lowercase();
            if !plain || is_loopback_host(&host) {
                return None;
            }
            Some(match authority.port_u16().filter(|port| *port != 443) {
                Some(port) => format!("https://{host}:{port}"),
                None => format!("https://{host}"),
            })
        })
    }
}

fn is_loopback_host(host: &str) -> bool {
    let host = host.trim_end_matches('.');
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    host == "localhost"
        || host.ends_with(".localhost")
        || bare
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback())
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            origins: vec!["http://localhost:7878".into()],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Serialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SecretBackendKind {
    // `keychain` and `onepassword` need a logged-in macOS session.
    /// The server's own encrypted vault, unlocked with its passphrase. The only
    /// choice that works for a server started before anyone logs in.
    Vault,
    #[default]
    Keychain,
    /// A 1Password item, reached through the `op` CLI.
    OnePassword,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct SecretsConfig {
    /// Unset means `settings.json`'s `secretBackend` decides, as it does for
    /// the desktop app (the Keychain when that's unset too). A server started
    /// by the desktop app on an existing install then keeps reading the store
    /// the user already chose, rather than quietly switching to the Keychain.
    pub backend: Option<SecretBackendKind>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct SshAgentConfig {
    /// Off by default. When off, the server never holds a signing key, and
    /// workspace shells get `upstream_socket` (or the server's own
    /// `SSH_AUTH_SOCK`) instead. Needs the vault backend, which holds the key.
    pub enabled: bool,
    /// The agent workspace shells use when `enabled` is off, such as
    /// 1Password's `~/Library/Group Containers/2BUA8C4S2C.com.1password/t/agent.sock`.
    /// Needed when the server runs under launchd, which doesn't pass on the
    /// login shell's `SSH_AUTH_SOCK`.
    pub upstream_socket: Option<PathBuf>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct SidecarConfig {
    /// Start and supervise the Bun sidecar. Tests and a server run against a
    /// sidecar started by hand turn this off.
    pub enabled: bool,
    /// The command that starts the sidecar. Unset means `bun run` on the
    /// sidecar's entry point in this checkout.
    pub command: Option<Vec<String>>,
    /// Where a compiled sidecar finds its database migrations, passed to it as
    /// `YARVIS_MIGRATIONS_DIR`. A sidecar run from the checkout finds them
    /// there, so this is for a packaged build.
    pub migrations_dir: Option<PathBuf>,
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            command: None,
            migrations_dir: None,
        }
    }
}

#[derive(Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct DatabaseConfig {
    /// The Postgres database the server and the sidecar share, such as
    /// `postgres://localhost:5432/yarvis`. `YARVIS_DATABASE_URL` wins over it.
    pub url: Option<String>,
    /// The schema the server's tables live in. Two servers on one database
    /// (a dev instance beside the main one, or tests) each need their own,
    /// or they share one account and devices.
    pub schema: String,
}

impl Default for DatabaseConfig {
    fn default() -> Self {
        Self {
            url: None,
            schema: crate::store::SCHEMA.to_string(),
        }
    }
}

// By hand, so a password in the URL never reaches a log through `{:?}`.
impl std::fmt::Debug for DatabaseConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DatabaseConfig")
            .field("url", &self.url.as_deref().map(crate::database_url::mask))
            .field("schema", &self.schema)
            .finish()
    }
}

fn default_data_dir() -> PathBuf {
    std::env::var_os("HOME")
        .map(|home| PathBuf::from(home).join(".yarvis").join("server"))
        .unwrap_or_else(|| PathBuf::from(".yarvis-server"))
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("couldn't read {path}: {source}")]
    Read {
        path: PathBuf,
        source: std::io::Error,
    },
    #[error("{path} isn't a valid config: {source}")]
    Parse {
        path: PathBuf,
        source: toml::de::Error,
    },
    #[error("{0}")]
    Invalid(String),
}

impl Config {
    /// Reads `path`. A missing file gives the defaults, so a first run needs
    /// no setup.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                let config = Self::default();
                config.validate()?;
                return Ok(config);
            }
            Err(source) => {
                return Err(ConfigError::Read {
                    path: path.into(),
                    source,
                });
            }
        };
        let config: Self = toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.into(),
            source,
        })?;
        config.validate()?;
        if config.database.url.is_some() {
            warn_if_others_can_read(path);
        }
        Ok(config)
    }

    /// Refuses combinations that would quietly do something unsafe.
    pub fn validate(&self) -> Result<(), ConfigError> {
        let invalid = |message: &str| Err(ConfigError::Invalid(message.into()));
        if !self.server.bind.ip().is_loopback() && !self.server.allow_plain_http {
            return invalid(
                "server.bind isn't loopback, and the server only speaks plain HTTP. Put TLS in \
                 front of it (for example `tailscale serve`) and set server.allow_plain_http = true",
            );
        }
        if self.ssh_agent.enabled && self.secrets.backend != Some(SecretBackendKind::Vault) {
            return invalid(
                "ssh_agent.enabled needs secrets.backend = \"vault\", which holds the signing key",
            );
        }
        if self.ssh_agent.enabled && self.ssh_agent.upstream_socket.is_some() {
            return invalid("ssh_agent.upstream_socket is only used when ssh_agent.enabled is off");
        }
        if let Some(path) = self.server.spawn_path() {
            check_spawn_path(path)?;
        }
        if self
            .server
            .socket_dir
            .as_ref()
            .is_some_and(|d| d.is_relative())
        {
            return invalid("server.socket_dir must be an absolute path");
        }
        if self.server.data_dir.is_relative() {
            return invalid(
                "server.data_dir must be an absolute path (HOME isn't set, so set it explicitly)",
            );
        }
        Ok(())
    }
}

/// Every entry of `[server] path` must be an absolute folder. An empty or
/// relative entry is looked up from the folder a process runs in, which for a
/// session is a repo checkout, so a `git` or `bun` planted there would run.
fn check_spawn_path(path: &str) -> Result<(), ConfigError> {
    for entry in path.split(':') {
        if entry.is_empty() {
            return Err(ConfigError::Invalid(format!(
                "server.path has an empty entry (a leading, trailing or doubled ':') in \"{path}\"; \
                 an empty entry means the current folder"
            )));
        }
        if !Path::new(entry).is_absolute() {
            return Err(ConfigError::Invalid(format!(
                "server.path entry \"{entry}\" isn't an absolute path; write it out in full \
                 (~ isn't expanded)"
            )));
        }
    }
    Ok(())
}

/// The database URL can carry a password, so a `server.toml` holding one
/// should be readable by its owner alone.
#[cfg(unix)]
fn warn_if_others_can_read(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    if let Ok(meta) = std::fs::metadata(path)
        && meta.permissions().mode() & 0o077 != 0
    {
        tracing::warn!(
            "{} holds the database URL and others can read it; run chmod 600 on it",
            path.display()
        );
    }
}

#[cfg(not(unix))]
fn warn_if_others_can_read(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_origin_is_the_first_https_one_off_loopback() {
        let auth = |origins: &[&str]| AuthConfig {
            origins: origins.iter().map(|o| o.to_string()).collect(),
        };
        assert_eq!(auth(&["http://localhost:7878"]).public_origin(), None);
        assert_eq!(
            auth(&[
                "https://localhost:7878",
                "https://[::1]",
                "https://127.0.0.2",
                "https://LOCALHOST.",
                "https://x.localhost",
                "https://evil@mini.example.ts.net",
                "https://mini.example.ts.net/path",
            ])
            .public_origin(),
            None
        );
        assert_eq!(
            auth(&["http://127.0.0.1:7878", "https://Mini.Example.ts.net:443/"]).public_origin(),
            Some("https://mini.example.ts.net".into())
        );
        assert_eq!(
            auth(&["https://mini.example.ts.net:8443"]).public_origin(),
            Some("https://mini.example.ts.net:8443".into())
        );
    }

    #[test]
    fn an_empty_file_gives_a_loopback_server_with_no_ssh_agent() {
        let config: Config = toml::from_str("").unwrap();
        assert!(config.server.bind.ip().is_loopback());
        assert_eq!(config.secrets.backend, None);
        assert!(!config.ssh_agent.enabled);
    }

    #[test]
    fn reads_a_work_laptop_config() {
        let config: Config = toml::from_str(
            r#"
            [secrets]
            backend = "onepassword"
            [ssh_agent]
            enabled = false
            "#,
        )
        .unwrap();
        assert_eq!(config.secrets.backend, Some(SecretBackendKind::OnePassword));
        assert!(!config.ssh_agent.enabled);
    }

    #[test]
    fn reads_the_database_url_and_hides_its_password_from_debug() {
        let config: Config =
            toml::from_str("[database]\nurl = \"postgres://me:s3cret@localhost/yarvis\"\n")
                .unwrap();
        assert_eq!(
            config.database.url.as_deref(),
            Some("postgres://me:s3cret@localhost/yarvis")
        );
        assert!(!format!("{config:?}").contains("s3cret"));
    }

    #[test]
    fn reads_the_path_for_spawned_processes_and_a_blank_one_is_unset() {
        let config: Config =
            toml::from_str("[server]\npath = \"/opt/homebrew/bin:/usr/bin:/bin\"\n").unwrap();
        assert_eq!(
            config.server.spawn_path(),
            Some("/opt/homebrew/bin:/usr/bin:/bin")
        );
        let blank: Config = toml::from_str("[server]\npath = \"  \"\n").unwrap();
        assert_eq!(blank.server.spawn_path(), None);
        assert_eq!(Config::default().server.spawn_path(), None);
    }

    #[test]
    fn refuses_a_path_with_an_empty_or_relative_entry() {
        let with_path = |path: &str| {
            let mut config = Config::default();
            config.server.path = Some(path.into());
            config.validate().map_err(|e| e.to_string())
        };
        with_path("/opt/homebrew/bin:/usr/bin:/bin").unwrap();
        for bad in ["/usr/bin::/bin", ":/usr/bin", "/usr/bin:"] {
            let err = with_path(bad).unwrap_err();
            assert!(err.contains("empty entry"), "{bad}: {err}");
        }
        for (bad, entry) in [
            ("/usr/bin:.", "\".\""),
            ("node_modules/.bin:/usr/bin", "\"node_modules/.bin\""),
            ("~/.local/bin:/usr/bin", "\"~/.local/bin\""),
        ] {
            let err = with_path(bad).unwrap_err();
            assert!(err.contains(entry), "{bad}: {err}");
        }
        // Blank is unset, not an empty entry.
        with_path("   ").unwrap();
    }

    #[test]
    fn socket_dir_must_be_absolute() {
        let config: Config = toml::from_str("[server]\nsocket_dir = \"/run/yarvis\"\n").unwrap();
        assert_eq!(
            config.server.socket_dir.as_deref(),
            Some(Path::new("/run/yarvis"))
        );
        config.validate().unwrap();
        let relative: Config = toml::from_str("[server]\nsocket_dir = \"run\"\n").unwrap();
        let err = relative.validate().unwrap_err().to_string();
        assert!(err.contains("socket_dir must be an absolute path"), "{err}");
    }

    #[test]
    fn rejects_a_misspelled_key() {
        let err = toml::from_str::<Config>("[ssh_agent]\nenable = true\n").unwrap_err();
        assert!(err.to_string().contains("enable"), "{err}");
    }

    #[test]
    fn the_defaults_are_valid() {
        Config::default().validate().unwrap();
    }

    #[test]
    fn refuses_a_lan_bind_without_an_opt_in() {
        let mut config: Config = toml::from_str("[server]\nbind = \"0.0.0.0:7878\"\n").unwrap();
        assert!(config.validate().is_err());
        config.server.allow_plain_http = true;
        config.validate().unwrap();
    }

    #[test]
    fn refuses_the_ssh_agent_without_the_vault() {
        let config: Config = toml::from_str("[ssh_agent]\nenabled = true\n").unwrap();
        let err = config.validate().unwrap_err().to_string();
        assert!(err.contains("vault"), "{err}");
    }

    #[test]
    fn load_checks_what_it_reads() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("server.toml");
        std::fs::write(&path, "[ssh_agent]\nenabled = true\n").unwrap();
        assert!(matches!(Config::load(&path), Err(ConfigError::Invalid(_))));
        std::fs::write(&path, "[server\n").unwrap();
        assert!(matches!(
            Config::load(&path),
            Err(ConfigError::Parse { .. })
        ));
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("server.toml")).unwrap();
        assert_eq!(config.secrets.backend, None);
    }
}
