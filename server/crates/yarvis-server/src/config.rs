//! The server's config file (`server.toml`).
//!
//! Every field has a default, so an empty file (or no file) gives a server on
//! 127.0.0.1 that keeps secrets in the macOS Keychain and runs no ssh-agent:
//! the same behavior as the desktop app today.

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
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            bind: SocketAddr::from(([127, 0, 0, 1], 7878)),
            data_dir: default_data_dir(),
            web_dir: None,
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
    pub backend: SecretBackendKind,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub struct SshAgentConfig {
    /// Off by default. When off, workspace shells keep the user's own
    /// `SSH_AUTH_SOCK` (1Password's agent on a work laptop) and the server
    /// never holds a signing key.
    pub enabled: bool,
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
}

impl Default for SidecarConfig {
    fn default() -> Self {
        Self {
            enabled: true,
            command: None,
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
}

impl Config {
    /// Reads `path`. A missing file gives the defaults, so a first run needs
    /// no setup.
    pub fn load(path: &Path) -> Result<Self, ConfigError> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Self::default()),
            Err(source) => {
                return Err(ConfigError::Read {
                    path: path.into(),
                    source,
                });
            }
        };
        toml::from_str(&text).map_err(|source| ConfigError::Parse {
            path: path.into(),
            source,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_empty_file_gives_a_loopback_server_with_no_ssh_agent() {
        let config: Config = toml::from_str("").unwrap();
        assert!(config.server.bind.ip().is_loopback());
        assert_eq!(config.secrets.backend, SecretBackendKind::Keychain);
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
        assert_eq!(config.secrets.backend, SecretBackendKind::OnePassword);
        assert!(!config.ssh_agent.enabled);
    }

    #[test]
    fn rejects_a_misspelled_key() {
        let err = toml::from_str::<Config>("[ssh_agent]\nenable = true\n").unwrap_err();
        assert!(err.to_string().contains("enable"), "{err}");
    }

    #[test]
    fn a_missing_file_gives_the_defaults() {
        let dir = tempfile::tempdir().unwrap();
        let config = Config::load(&dir.path().join("server.toml")).unwrap();
        assert_eq!(config.secrets.backend, SecretBackendKind::Keychain);
    }
}
