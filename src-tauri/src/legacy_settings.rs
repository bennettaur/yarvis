//! Moves a `settings.json` left in the app-data folder by a build from before
//! #277 to where the server reads settings, so upgrading doesn't reset a
//! stored PTY cap or agent command. It lives in the app rather than the server
//! because only the app knows its app-data folder, which is per bundle
//! identifier.

use std::path::{Path, PathBuf};

/// Where the server reads `settings.json`: `YARVIS_SETTINGS_PATH`, else
/// `~/.yarvis/settings.json`. Matches `SettingsStore::default_path` in the
/// server, which a local server inherits this app's environment for.
pub fn server_settings_path() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("YARVIS_SETTINGS_PATH").filter(|p| !p.is_empty()) {
        return Some(PathBuf::from(path));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".yarvis").join("settings.json"))
}

/// Moves `app_data_dir/settings.json` to `target` when nothing is at `target`
/// yet. Best-effort: a file left behind on failure is harmless, and the server
/// then starts with defaults as it would on a fresh install.
pub fn migrate(app_data_dir: &Path, target: &Path) {
    let old = app_data_dir.join("settings.json");
    if target.exists() || !old.exists() {
        return;
    }
    if let Some(dir) = target.parent() {
        if let Err(e) = create_private_dir(dir) {
            eprintln!("[settings] couldn't create {}: {e}", dir.display());
            return;
        }
    }
    if let Err(e) = std::fs::rename(&old, target) {
        eprintln!(
            "[settings] couldn't move {} to {}: {e}",
            old.display(),
            target.display()
        );
    }
}

/// `~/.yarvis` holds the secrets lock and settings that can name a JIRA
/// account, so only its owner may enter it, as the server makes it.
fn create_private_dir(dir: &Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(dir, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_old_file_moves_into_a_fresh_yarvis_folder() {
        let dir = tempfile::tempdir().unwrap();
        let app_data = dir.path().join("app-data");
        std::fs::create_dir(&app_data).unwrap();
        std::fs::write(app_data.join("settings.json"), r#"{"maxPtySessions":5}"#).unwrap();
        let target = dir
            .path()
            .join("home")
            .join(".yarvis")
            .join("settings.json");

        migrate(&app_data, &target);

        assert_eq!(
            std::fs::read_to_string(&target).unwrap(),
            r#"{"maxPtySessions":5}"#
        );
        assert!(!app_data.join("settings.json").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(target.parent().unwrap())
                .unwrap()
                .permissions()
                .mode();
            assert_eq!(mode & 0o777, 0o700);
        }
    }

    #[test]
    fn settings_already_in_place_are_never_replaced() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("settings.json"), "old").unwrap();
        let target = dir.path().join("current.json");
        std::fs::write(&target, "current").unwrap();

        migrate(dir.path(), &target);

        assert_eq!(std::fs::read_to_string(&target).unwrap(), "current");
        assert_eq!(
            std::fs::read_to_string(dir.path().join("settings.json")).unwrap(),
            "old"
        );
    }

    #[test]
    fn with_no_old_file_nothing_is_created() {
        let dir = tempfile::tempdir().unwrap();
        let target = dir.path().join(".yarvis").join("settings.json");
        migrate(dir.path(), &target);
        assert!(!target.parent().unwrap().exists());
    }
}
