//! Which yarvis-server this app talks to.
//!
//! Kept in `connection.json` in the app data dir, so each `dev:instance` copy
//! has its own. The file holds no secret: the device token lives in the
//! Keychain (`device_token.rs`).
//!
//! - **Local** (the default) starts the bundled server on loopback, so a single
//!   Mac works with one app and no setup.
//! - **Remote** connects to a server on another machine, paired with a token
//!   minted from a signed-in browser's Devices page.

use std::net::IpAddr;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};
use tauri::Url;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Local,
    Remote,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionConfig {
    pub mode: Mode,
    /// The remote server's origin, such as `https://yarvis.example.com`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub remote_url: Option<String>,
    /// The port the local server last listened on. Reused when it is still
    /// free, so a browser tab or bookmark on the same Mac keeps working.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub local_port: Option<u16>,
}

pub fn config_path(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("connection.json")
}

/// Reads the config. A missing file is a first run and gives local mode; a
/// file that doesn't parse is an error rather than a silent switch to local,
/// which would start a second server the user didn't ask for.
pub fn load(path: &Path) -> Result<ConnectionConfig, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str(&text)
            .map_err(|e| format!("{} isn't a valid connection config: {e}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConnectionConfig::default()),
        Err(e) => Err(format!("couldn't read {}: {e}", path.display())),
    }
}

/// Writes the config with an atomic rename, so a crash mid-write can't leave a
/// half-written file that `load` then refuses.
pub fn save(path: &Path, config: &ConnectionConfig) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("couldn't create {}: {e}", dir.display()))?;
    }
    let json = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, json).map_err(|e| format!("couldn't write {}: {e}", tmp.display()))?;
    std::fs::rename(&tmp, path).map_err(|e| format!("couldn't write {}: {e}", path.display()))
}

/// Reduces a user-entered server URL to its origin (`scheme://host[:port]`).
///
/// The device token goes to this origin on every request, and the page loaded
/// from it can call the bridge commands, so plain `http` is only accepted for
/// loopback, where nothing crosses the network.
pub fn normalize_remote_url(raw: &str) -> Result<String, String> {
    let url = Url::parse(raw.trim()).map_err(|e| format!("not a valid URL: {e}"))?;
    let host = url.host_str().ok_or("the URL has no host")?;
    match url.scheme() {
        "https" => {}
        "http" if is_loopback(host) => {}
        "http" => {
            return Err("use https: the device token would cross the network in the clear".into())
        }
        other => return Err(format!("unsupported scheme {other}")),
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("the URL can't carry a user name or password".into());
    }
    Ok(url.origin().ascii_serialization())
}

fn is_loopback(host: &str) -> bool {
    if host == "localhost" {
        return true;
    }
    host.trim_start_matches('[')
        .trim_end_matches(']')
        .parse::<IpAddr>()
        .is_ok_and(|ip| ip.is_loopback())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_first_run_is_local_mode() {
        let dir = tempfile::tempdir().unwrap();
        let config = load(&config_path(dir.path())).unwrap();
        assert_eq!(config, ConnectionConfig::default());
        assert_eq!(config.mode, Mode::Local);
    }

    #[test]
    fn a_saved_config_reads_back() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        let config = ConnectionConfig {
            mode: Mode::Remote,
            remote_url: Some("https://yarvis.example.com".into()),
            local_port: Some(7123),
        };
        save(&path, &config).unwrap();
        assert_eq!(load(&path).unwrap(), config);
    }

    #[test]
    fn a_corrupt_file_is_an_error_not_local_mode() {
        let dir = tempfile::tempdir().unwrap();
        let path = config_path(dir.path());
        std::fs::write(&path, "{ not json").unwrap();
        assert!(load(&path).is_err());
    }

    #[test]
    fn a_remote_url_is_reduced_to_its_origin() {
        assert_eq!(
            normalize_remote_url(" https://yarvis.example.com/settings?tab=devices ").unwrap(),
            "https://yarvis.example.com"
        );
        assert_eq!(
            normalize_remote_url("https://mini.tail1234.ts.net:8443/").unwrap(),
            "https://mini.tail1234.ts.net:8443"
        );
    }

    #[test]
    fn plain_http_is_refused_off_loopback() {
        assert!(normalize_remote_url("http://yarvis.example.com").is_err());
        assert!(normalize_remote_url("http://192.168.1.20:7878").is_err());
    }

    #[test]
    fn plain_http_is_accepted_on_loopback() {
        assert_eq!(
            normalize_remote_url("http://127.0.0.1:7878").unwrap(),
            "http://127.0.0.1:7878"
        );
        assert_eq!(
            normalize_remote_url("http://localhost:7878").unwrap(),
            "http://localhost:7878"
        );
        assert_eq!(
            normalize_remote_url("http://[::1]:7878").unwrap(),
            "http://[::1]:7878"
        );
    }

    #[test]
    fn other_schemes_and_credentials_are_refused() {
        assert!(normalize_remote_url("file:///etc/passwd").is_err());
        assert!(normalize_remote_url("javascript:alert(1)").is_err());
        assert!(normalize_remote_url("https://user:pw@yarvis.example.com").is_err());
        assert!(normalize_remote_url("not a url").is_err());
    }
}
