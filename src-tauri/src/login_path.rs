//! The `PATH` the user's own shell would have.
//!
//! An app launched from Finder inherits launchd's minimal `PATH`
//! (`/usr/bin:/bin:/usr/sbin:/sbin`), with no Homebrew, mise or Bun on it. The
//! sidecar runs `gh` and workspace setup scripts that expect the tools the user
//! has in a terminal, so a packaged build hands it this `PATH` instead.

use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{mpsc, OnceLock};
use std::time::Duration;

/// Long enough for a shell with a heavy rc file; short enough that a prompt
/// waiting on input can't hold up the sidecar's start.
const SHELL_TIMEOUT: Duration = Duration::from_secs(5);

/// Wraps the printed value, so whatever the rc files print around it is ignored.
const MARKER: &str = "__YARVIS_PATH__";

/// Pulls the marked value out of the shell's output, keeping only absolute
/// entries: an empty or relative one would resolve against the sidecar's
/// working directory.
fn extract_path(output: &str) -> Option<String> {
    let start = output.find(MARKER)? + MARKER.len();
    let len = output[start..].find(MARKER)?;
    let entries: Vec<&str> = output[start..start + len]
        .trim()
        .split(':')
        .filter(|entry| entry.starts_with('/'))
        .collect();
    (!entries.is_empty()).then(|| entries.join(":"))
}

/// Runs the user's shell as an interactive login shell, so both its profile and
/// its rc file (where tools like mise are usually activated) are read.
fn read_from_shell() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    read_from(&shell)
}

fn read_from(shell: &str) -> Option<String> {
    let script = format!("printf '{MARKER}%s{MARKER}' \"$PATH\"");
    let mut child = Command::new(shell)
        .args(["-ilc", &script])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        // Its own process group, so anything the rc files start goes with it.
        .process_group(0)
        .spawn()
        .inspect_err(|e| eprintln!("[login_path] could not run {shell}: {e}"))
        .ok()?;

    // Read until the value is complete rather than to EOF: a process the rc
    // files leave running in the background can hold stdout open indefinitely.
    let mut stdout = child.stdout.take()?;
    let (tx, rx) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        loop {
            match stdout.read(&mut chunk) {
                Ok(0) | Err(_) => break,
                Ok(n) => output.extend_from_slice(&chunk[..n]),
            }
            if extract_path(&String::from_utf8_lossy(&output)).is_some() {
                break;
            }
        }
        let _ = tx.send(extract_path(&String::from_utf8_lossy(&output)));
    });

    let path = rx.recv_timeout(SHELL_TIMEOUT).unwrap_or_else(|_| {
        eprintln!(
            "[login_path] {shell} did not answer within {}s",
            SHELL_TIMEOUT.as_secs()
        );
        None
    });
    // SAFETY: killpg only sends a signal; the group is the one spawned above.
    unsafe {
        libc::killpg(child.id() as libc::pid_t, libc::SIGKILL);
    }
    let _ = child.wait();
    path
}

/// The login shell's `PATH`, read once per run. `None` when the shell couldn't
/// be read, in which case the caller keeps the inherited one.
pub fn get() -> Option<&'static str> {
    static PATH: OnceLock<Option<String>> = OnceLock::new();
    PATH.get_or_init(read_from_shell).as_deref()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_marked_value_past_rc_file_noise() {
        let output = format!("Welcome!\n{MARKER}/opt/homebrew/bin:/usr/bin{MARKER}\nbye");
        assert_eq!(
            extract_path(&output).as_deref(),
            Some("/opt/homebrew/bin:/usr/bin")
        );
    }

    #[test]
    fn reads_path_from_a_real_shell() {
        let path = read_from("/bin/sh").expect("/bin/sh reports a PATH");
        assert!(path.contains("/bin"), "unexpected PATH: {path}");
    }

    #[test]
    fn drops_empty_and_relative_entries() {
        let output = format!("{MARKER}:.:/usr/bin::bin:/bin:{MARKER}");
        assert_eq!(extract_path(&output).as_deref(), Some("/usr/bin:/bin"));
    }

    #[test]
    fn missing_or_empty_markers_read_as_nothing() {
        assert_eq!(extract_path("no markers here"), None);
        assert_eq!(extract_path(&format!("{MARKER}/usr/bin")), None);
        assert_eq!(extract_path(&format!("{MARKER}{MARKER}")), None);
    }
}
