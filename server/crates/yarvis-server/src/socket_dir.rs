//! Where the server puts its Unix sockets (the control socket and the
//! ssh-agent socket).
//!
//! A socket's path has to fit in `sun_path`, which is 104 bytes on macOS and
//! 108 on Linux, so a socket in a deeply nested data dir can't be bound. In
//! order, a socket goes in:
//!
//! 1. `[server] socket_dir`, when it is set.
//! 2. The data dir, when the path fits.
//! 3. `~/.yarvis/run/<hash of the data dir>/`, so each server gets its own
//!    folder and finds the same one on every run.
//!
//! Temp folders are never used: macOS and systemd delete old files there,
//! which would take a long-running server's socket away.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::SocketAddr;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::config::ServerConfig;

/// The path for the socket `name`. When nothing fits it is still the data dir
/// path, and [`prepare`] refuses it.
pub fn socket_path(server: &ServerConfig, name: &str) -> PathBuf {
    socket_path_with_home(server, home().as_deref(), name)
}

/// Gets the directory of a [`socket_path`] ready to bind in. Errors when the
/// path is too long to bind, or when the directory isn't private.
///
/// A socket in the data dir needs nothing more: the data dir is the server's
/// own, made 0700 at startup. Elsewhere the directory's permissions alone
/// decide who can connect, so it is created mode 0700 if missing, and one that
/// already exists must be a real directory (not a symlink) owned by this user
/// with mode 0700.
pub fn prepare(server: &ServerConfig, socket: &Path) -> Result<(), String> {
    prepare_with_home(server, home().as_deref(), socket)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .filter(|h| !h.is_empty())
        .map(PathBuf::from)
}

fn socket_path_with_home(server: &ServerConfig, home: Option<&Path>, name: &str) -> PathBuf {
    if let Some(dir) = &server.socket_dir {
        return dir.join(name);
    }
    let in_data_dir = server.data_dir.join(name);
    if fits(&in_data_dir) {
        return in_data_dir;
    }
    home.map(|home| run_dir(home, &server.data_dir).join(name))
        .filter(|path| fits(path))
        .unwrap_or(in_data_dir)
}

fn prepare_with_home(
    server: &ServerConfig,
    home: Option<&Path>,
    socket: &Path,
) -> Result<(), String> {
    if !fits(socket) {
        let fix = if server.socket_dir.is_some() {
            "choose a shorter [server] socket_dir"
        } else {
            "set [server] socket_dir in server.toml to a shorter folder"
        };
        return Err(format!(
            "the socket path {} is too long for a Unix socket; {fix}",
            socket.display()
        ));
    }
    let dir = socket
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", socket.display()))?;
    if server.socket_dir.is_none() && dir == server.data_dir {
        return Ok(());
    }
    if let Some(home) = home
        && dir == run_dir(home, &server.data_dir)
    {
        // `~/.yarvis` is normally made 0700 already; it only needs to exist.
        let yarvis = home.join(".yarvis");
        std::fs::DirBuilder::new()
            .recursive(true)
            .mode(0o700)
            .create(&yarvis)
            .map_err(|e| format!("couldn't create {}: {e}", yarvis.display()))?;
        private_dir(&yarvis.join("run"))?;
    }
    private_dir(dir)
}

/// Creates `dir` mode 0700, or checks that the one already there is a real
/// directory owned by this user with mode 0700. One that isn't is refused,
/// not tightened, since another user may have made it first.
fn private_dir(dir: &Path) -> Result<(), String> {
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        // The umask can only clear bits, so make sure the mode is exactly 0700.
        Ok(()) => {
            return std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
                .map_err(|e| format!("couldn't make {} private: {e}", dir.display()));
        }
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("couldn't create {}: {e}", dir.display())),
    }
    let meta = std::fs::symlink_metadata(dir)
        .map_err(|e| format!("couldn't inspect {}: {e}", dir.display()))?;
    if !meta.file_type().is_dir() {
        return Err(format!("{} isn't a directory", dir.display()));
    }
    // SAFETY: geteuid has no preconditions and can't fail.
    let uid = unsafe { libc::geteuid() };
    if meta.uid() != uid {
        return Err(format!("{} is owned by another user", dir.display()));
    }
    let mode = meta.permissions().mode() & 0o777;
    if mode != 0o700 {
        return Err(format!(
            "{} has mode {mode:o}, not 700, so other users may reach the socket",
            dir.display()
        ));
    }
    Ok(())
}

/// Whether `path` is short enough to bind as a Unix socket on this OS.
fn fits(path: &Path) -> bool {
    SocketAddr::from_pathname(path).is_ok()
}

/// `~/.yarvis/run/<hash>`, where the hash is of the data dir.
fn run_dir(home: &Path, data_dir: &Path) -> PathBuf {
    let digest = Sha256::digest(data_dir.as_os_str().as_encoded_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    home.join(".yarvis").join("run").join(hex)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_dir(under: &Path) -> PathBuf {
        under.join("a-data-dir-whose-name-goes-on-".repeat(5))
    }

    fn server(data_dir: &Path, socket_dir: Option<&Path>) -> ServerConfig {
        ServerConfig {
            data_dir: data_dir.to_path_buf(),
            socket_dir: socket_dir.map(Path::to_path_buf),
            ..ServerConfig::default()
        }
    }

    fn mode_of(path: &Path) -> u32 {
        std::fs::metadata(path).unwrap().permissions().mode() & 0o777
    }

    #[test]
    fn a_short_data_dir_keeps_its_sockets() {
        let server = server(Path::new("/srv/yarvis"), None);
        let path = socket_path_with_home(&server, Some(Path::new("/home/me")), "s.sock");
        assert_eq!(path, Path::new("/srv/yarvis/s.sock"));
    }

    #[test]
    fn socket_dir_wins_even_over_a_short_data_dir() {
        let server = server(Path::new("/srv/yarvis"), Some(Path::new("/run/yarvis")));
        let path = socket_path_with_home(&server, Some(Path::new("/home/me")), "s.sock");
        assert_eq!(path, Path::new("/run/yarvis/s.sock"));
    }

    #[test]
    fn a_long_data_dir_gets_a_stable_folder_under_the_home_dir() {
        let home = tempfile::tempdir().unwrap();
        let data_dir = long_dir(home.path());
        let path = socket_path_with_home(&server(&data_dir, None), Some(home.path()), "s.sock");
        assert!(
            path.starts_with(home.path().join(".yarvis/run")),
            "{}",
            path.display()
        );
        assert_eq!(
            path,
            socket_path_with_home(&server(&data_dir, None), Some(home.path()), "s.sock"),
            "the same data dir finds the same folder on every run"
        );
    }

    #[test]
    fn another_data_dir_gets_another_folder() {
        let home = Path::new("/home/me");
        let a = long_dir(Path::new("/a"));
        let b = long_dir(Path::new("/b"));
        assert_ne!(
            socket_path_with_home(&server(&a, None), Some(home), "s.sock"),
            socket_path_with_home(&server(&b, None), Some(home), "s.sock"),
        );
    }

    #[test]
    fn prepare_makes_the_home_folders_private() {
        let home = tempfile::tempdir().unwrap();
        let server = server(&long_dir(home.path()), None);
        let socket = socket_path_with_home(&server, Some(home.path()), "s.sock");
        prepare_with_home(&server, Some(home.path()), &socket).unwrap();
        assert_eq!(mode_of(&home.path().join(".yarvis/run")), 0o700);
        assert_eq!(mode_of(socket.parent().unwrap()), 0o700);
        prepare_with_home(&server, Some(home.path()), &socket).unwrap();
    }

    #[test]
    fn prepare_refuses_a_run_folder_others_can_reach() {
        let home = tempfile::tempdir().unwrap();
        let run = home.path().join(".yarvis/run");
        std::fs::create_dir_all(&run).unwrap();
        std::fs::set_permissions(&run, std::fs::Permissions::from_mode(0o755)).unwrap();
        let server = server(&long_dir(home.path()), None);
        let socket = socket_path_with_home(&server, Some(home.path()), "s.sock");
        let err = prepare_with_home(&server, Some(home.path()), &socket).unwrap_err();
        assert!(err.contains("not 700"), "{err}");
    }

    #[test]
    fn prepare_creates_a_missing_socket_dir() {
        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("sockets");
        let server = server(Path::new("/srv/yarvis"), Some(&dir));
        prepare_with_home(&server, None, &dir.join("s.sock")).unwrap();
        assert_eq!(mode_of(&dir), 0o700);
    }

    #[test]
    fn prepare_refuses_a_socket_dir_others_can_reach() {
        let base = tempfile::tempdir().unwrap();
        let dir = base.path().join("sockets");
        std::fs::create_dir(&dir).unwrap();
        std::fs::set_permissions(&dir, std::fs::Permissions::from_mode(0o777)).unwrap();
        let server = server(Path::new("/srv/yarvis"), Some(&dir));
        let err = prepare_with_home(&server, None, &dir.join("s.sock")).unwrap_err();
        assert!(err.contains("not 700"), "{err}");
        assert_eq!(mode_of(&dir), 0o777, "left as found, not taken over");
    }

    #[test]
    fn prepare_refuses_a_symlinked_socket_dir() {
        let base = tempfile::tempdir().unwrap();
        let elsewhere = base.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = base.path().join("sockets");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let server = server(Path::new("/srv/yarvis"), Some(&link));
        let err = prepare_with_home(&server, None, &link.join("s.sock")).unwrap_err();
        assert!(err.contains("isn't a directory"), "{err}");
    }

    #[test]
    fn prepare_refuses_a_socket_dir_another_user_owns() {
        // SAFETY: geteuid has no preconditions and can't fail.
        if unsafe { libc::geteuid() } == 0 {
            return; // root owns /usr, so there is no other user to test against
        }
        let server = server(Path::new("/srv/yarvis"), Some(Path::new("/usr")));
        let err = prepare_with_home(&server, None, Path::new("/usr/s.sock")).unwrap_err();
        assert!(err.contains("owned by another user"), "{err}");
    }

    #[test]
    fn prepare_leaves_the_data_dir_to_the_server() {
        let base = tempfile::tempdir().unwrap();
        std::fs::set_permissions(base.path(), std::fs::Permissions::from_mode(0o755)).unwrap();
        let server = server(base.path(), None);
        prepare_with_home(&server, None, &base.path().join("s.sock")).unwrap();
    }

    #[test]
    fn a_path_too_long_everywhere_asks_for_socket_dir() {
        let base = tempfile::tempdir().unwrap();
        let data_dir = long_dir(base.path());
        let server = server(&data_dir, None);
        let socket = socket_path_with_home(&server, Some(&long_dir(base.path())), "s.sock");
        assert_eq!(socket, data_dir.join("s.sock"));
        let err = prepare_with_home(&server, None, &socket).unwrap_err();
        assert!(err.contains("set [server] socket_dir"), "{err}");
    }

    #[test]
    fn a_socket_dir_too_long_says_so() {
        let base = tempfile::tempdir().unwrap();
        let dir = long_dir(base.path());
        let server = server(Path::new("/srv/yarvis"), Some(&dir));
        let err = prepare_with_home(&server, None, &dir.join("s.sock")).unwrap_err();
        assert!(
            err.contains("choose a shorter [server] socket_dir"),
            "{err}"
        );
    }
}
