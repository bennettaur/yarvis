//! Where the server puts its Unix sockets (the control socket and the
//! ssh-agent socket).
//!
//! A socket's path has to fit in `sun_path`, which is 104 bytes on macOS and
//! 108 on Linux, so a socket in a deeply nested data dir can't be bound. Such
//! a socket goes in a private directory under a short system path instead,
//! named from a hash of the data dir so each server gets its own and finds the
//! same one on every run.

use std::os::unix::fs::{DirBuilderExt, MetadataExt, PermissionsExt};
use std::os::unix::net::SocketAddr;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

/// The path for the socket `name`: in `data_dir` when that fits, otherwise in
/// `yarvis-<hash>` under the first short base directory where it fits. When
/// nothing fits it is still the data dir path, and [`prepare`] refuses it.
pub fn socket_path(data_dir: &Path, name: &str) -> PathBuf {
    let in_data_dir = data_dir.join(name);
    if fits(&in_data_dir) {
        return in_data_dir;
    }
    let dir_name = short_dir_name(data_dir);
    short_bases()
        .into_iter()
        .map(|base| base.join(&dir_name).join(name))
        .find(|path| fits(path))
        .unwrap_or(in_data_dir)
}

/// Gets the socket's directory ready to bind in: it must be a real directory
/// (not a symlink) owned by this user, and is made mode 0700, since those
/// permissions alone decide who can connect. A short directory is created if
/// missing. Errors when the path is too long to bind.
pub fn prepare(socket: &Path) -> Result<(), String> {
    if !fits(socket) {
        return Err(format!(
            "the socket path {} is too long for a Unix socket, and no shorter private directory \
             could be used; choose a shorter data_dir",
            socket.display()
        ));
    }
    let dir = socket
        .parent()
        .ok_or_else(|| format!("{} has no parent directory", socket.display()))?;
    match std::fs::DirBuilder::new().mode(0o700).create(dir) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(format!("couldn't create {}: {e}", dir.display())),
    }
    // A short directory sits in a shared place like /tmp, where another user
    // could have made it first, so check it before trusting it.
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
    std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))
        .map_err(|e| format!("couldn't make {} private: {e}", dir.display()))
}

/// Whether `path` is short enough to bind as a Unix socket on this OS.
fn fits(path: &Path) -> bool {
    SocketAddr::from_pathname(path).is_ok()
}

/// Short, per-user places to try, best first. `XDG_RUNTIME_DIR` is private
/// and never aged out; `TMPDIR` is per-user on macOS; `/tmp` is the fallback.
fn short_bases() -> Vec<PathBuf> {
    let mut bases: Vec<PathBuf> = ["XDG_RUNTIME_DIR", "TMPDIR"]
        .into_iter()
        .filter_map(std::env::var_os)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .collect();
    bases.push(PathBuf::from("/tmp"));
    bases
}

fn short_dir_name(data_dir: &Path) -> String {
    let digest = Sha256::digest(data_dir.as_os_str().as_encoded_bytes());
    let hex: String = digest[..8].iter().map(|b| format!("{b:02x}")).collect();
    format!("yarvis-{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn long_dir(under: &Path) -> PathBuf {
        under.join("a-data-dir-whose-name-goes-on-".repeat(5))
    }

    #[test]
    fn a_short_data_dir_keeps_its_sockets() {
        let path = socket_path(Path::new("/srv/yarvis"), "core-control.sock");
        assert_eq!(path, Path::new("/srv/yarvis/core-control.sock"));
    }

    #[test]
    fn a_long_data_dir_gets_a_short_stable_private_path() {
        let data = tempfile::tempdir().unwrap();
        let data_dir = long_dir(data.path());
        let path = socket_path(&data_dir, "core-control.sock");
        assert!(!path.starts_with(&data_dir));
        assert!(fits(&path));
        assert_eq!(path, socket_path(&data_dir, "core-control.sock"));
        assert_ne!(
            path.parent(),
            socket_path(&long_dir(&data_dir), "core-control.sock").parent(),
            "another data dir gets another directory"
        );
    }

    #[test]
    fn prepare_makes_the_directory_private() {
        let base = tempfile::tempdir().unwrap();
        let socket = base.path().join("yarvis-x").join("s.sock");
        prepare(&socket).unwrap();
        let mode = std::fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700);

        std::fs::set_permissions(
            socket.parent().unwrap(),
            std::fs::Permissions::from_mode(0o755),
        )
        .unwrap();
        prepare(&socket).unwrap();
        let mode = std::fs::metadata(socket.parent().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o700, "a loosened directory is tightened");
    }

    #[test]
    fn prepare_refuses_a_symlinked_directory() {
        let base = tempfile::tempdir().unwrap();
        let elsewhere = base.path().join("elsewhere");
        std::fs::create_dir(&elsewhere).unwrap();
        let link = base.path().join("yarvis-x");
        std::os::unix::fs::symlink(&elsewhere, &link).unwrap();
        let err = prepare(&link.join("s.sock")).unwrap_err();
        assert!(err.contains("isn't a directory"), "{err}");
    }

    #[test]
    fn prepare_refuses_a_path_too_long_to_bind() {
        let base = tempfile::tempdir().unwrap();
        let err = prepare(&long_dir(base.path()).join("s.sock")).unwrap_err();
        assert!(err.contains("too long"), "{err}");
    }
}
