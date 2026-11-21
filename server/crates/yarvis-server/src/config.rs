//! The server's config file (`server.toml`).
//!
//! Every field has a default, so an empty file (or no file) gives a server on
//! 127.0.0.1 that keeps secrets wherever the desktop app's settings say (the
//! macOS Keychain unless they name 1Password) and runs no ssh-agent: the same
//! behavior as the desktop app.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub server: ServerConfig,
    pub auth: AuthConfig,
    pub secrets: SecretsConfig,
    pub ssh_agent: SshAgentConfig,
    pub sidecar: SidecarConfig,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct ServerConfig {
    /// Loopback by default. Binding a LAN or tailnet address is a deliberate
    /// choice, since it is what makes the server reachable from other machines.
    pub bind: SocketAddr,
    /// Where the server keeps its SQLite database and, with the vault backend,
    /// the vault file.
    pub data_dir: PathBuf,
    /// The built web UI (`dist/`). Unset means the server serves only `/api`.
    pub web_dir: Option<PathBuf>,
    /// The server speaks plain HTTP. Binding anything but loopback sends
    /// tokens in the clear, so it is refused unless this is set, which is
    /// for a server behind something that adds TLS, such as `tailscale serve`.
    pub allow_plain_http: bool,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 7878)),
            data_dir: default_data_dir(),
            web_dir: None,
            allow_plain_http: false,
        }
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct AuthConfig {
    /// The WebAuthn relying party ID. Passkeys are bound to it for good, so
    /// changing it later means registering every passkey again.
    pub rp_id: String,
    /// The origins a browser may sign in from, such as `https://yarvis.example.com`.
    pub origins: Vec<String>,
}

impl AuthConfig {
    /// The origin other machines reach this server on: the first `https`
    /// origin that isn't loopback, such as a `tailscale serve` name. OAuth
    /// redirects go there, so they work from a browser anywhere. `None` for a
    /// server only reached on loopback.
    pub fn public_origin(&self) -> Option<&str> {
        self.origins
            .iter()
            .map(|o| o.trim_end_matches('/'))
            .find(|origin| {
                let Some(host) = origin.strip_prefix("https://") else {
                    return false;
                };
                let host = host.split(':').next().unwrap_or_default();
                !matches!(host, "localhost" | "127.0.0.1" | "[") && !host.starts_with('[')
            })
    }
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            rp_id: "localhost".into(),
            origins: vec!["http://localhost:7878".into()],
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum SecretBackendKind {
    // `keychain` and `onepassword` need a logged-in macOS session.
    /// The server's own encrypted vault, unlocked with a passkey. The only
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
        if self.server.data_dir.is_relative() {
            return invalid(
                "server.data_dir must be an absolute path (HOME isn't set, so set it explicitly)",
            );
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_public_origin_is_the_first_https_one_off_loopback() {
        let auth = |origins: &[&str]| AuthConfig {
            rp_id: "x".into(),
            origins: origins.iter().map(|o| o.to_string()).collect(),
        };
        assert_eq!(auth(&["http://localhost:7878"]).public_origin(), None);
        assert_eq!(
            auth(&["https://localhost:7878", "https://[::1]"]).public_origin(),
            None
        );
        assert_eq!(
            auth(&["http://127.0.0.1:7878", "https://mini.example.ts.net/"]).public_origin(),
            Some("https://mini.example.ts.net")
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
