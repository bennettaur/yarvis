//! What the server asks the OS about its PTYs: how many descriptors it may
//! hold, and which executable a foreground process is running.

/// Soft file-descriptor limit aimed for at startup. Each live session holds
/// several descriptors (the PTY master plus the cloned reader and the writer
/// taken from it), so the session cap alone doesn't bound fd use. Chosen with
/// room to spare above what `MAX_CONFIGURABLE_SESSIONS` sessions need, and
/// under macOS's `kern.maxfilesperproc`, above which `setrlimit` refuses the
/// request outright.
#[cfg(unix)]
const DESIRED_FD_LIMIT: libc::rlim_t = 4096;

/// Raises the soft file-descriptor limit toward `DESIRED_FD_LIMIT` so the
/// session cap, not the fd budget, is what stops new terminals. A process
/// launchd starts (a LaunchAgent, an app opened from Finder) inherits a soft
/// limit of 256 regardless of the shell's, which several dozen live sessions
/// plus the server's own sockets can exhaust. An `EMFILE` then surfaces on
/// whatever opens a descriptor next (the control socket, a client connection,
/// the database) rather than as the session-cap error. Best effort: a failure here leaves the inherited limit in place.
#[cfg(unix)]
pub fn raise_fd_limit() -> Result<(), String> {
    let mut limit = libc::rlimit {
        rlim_cur: 0,
        rlim_max: 0,
    };
    // SAFETY: `getrlimit` only writes the initialized `rlimit` we own.
    if unsafe { libc::getrlimit(libc::RLIMIT_NOFILE, &mut limit) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let Some(target) = target_fd_limit(limit.rlim_cur, limit.rlim_max) else {
        return Ok(());
    };
    limit.rlim_cur = target;
    // SAFETY: `setrlimit` only reads the initialized `rlimit` we own. `rlim_max`
    // is passed back as read, so the hard limit is never raised or lowered.
    if unsafe { libc::setrlimit(libc::RLIMIT_NOFILE, &limit) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(())
}

/// The soft limit to raise to, or `None` when the inherited one already suffices
/// and the call can be skipped. Never lowers an existing limit and never exceeds
/// the hard limit, which is what a process without privileges is allowed to ask
/// for. Extracted from `raise_fd_limit` so the arithmetic is unit-testable
/// without touching the process's real limits.
#[cfg(unix)]
fn target_fd_limit(soft: libc::rlim_t, hard: libc::rlim_t) -> Option<libc::rlim_t> {
    // An infinite hard limit imposes no ceiling of its own, so ask for the full
    // desired amount.
    let ceiling = if hard == libc::RLIM_INFINITY {
        DESIRED_FD_LIMIT
    } else {
        hard.min(DESIRED_FD_LIMIT)
    };
    (soft < ceiling).then_some(ceiling)
}

/// Absolute path to a running process's executable, or None when it can't be
/// read (the process exited, the platform offers no way to ask, or the call was
/// refused). Callers treat None as "unidentified", so every such case fails closed.
#[cfg(target_os = "macos")]
pub(crate) fn process_executable(pid: u32) -> Option<String> {
    // `proc_pidpath` writes a NUL-terminated path and returns its length, or 0
    // on failure.
    let mut buf = vec![0u8; libc::PROC_PIDPATHINFO_MAXSIZE as usize];
    // SAFETY: `proc_pidpath` writes at most `buf.len()` bytes into the buffer we
    // own and only reads the pid by value.
    let written = unsafe {
        libc::proc_pidpath(
            pid as libc::c_int,
            buf.as_mut_ptr() as *mut libc::c_void,
            buf.len() as u32,
        )
    };
    if written <= 0 {
        return None;
    }
    buf.truncate(written as usize);
    String::from_utf8(buf).ok()
}

#[cfg(target_os = "linux")]
pub(crate) fn process_executable(pid: u32) -> Option<String> {
    std::fs::read_link(format!("/proc/{pid}/exe"))
        .ok()
        .map(|p| p.to_string_lossy().to_string())
}

#[cfg(not(any(target_os = "macos", target_os = "linux")))]
pub(crate) fn process_executable(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    mod fd_limit {
        use super::super::{DESIRED_FD_LIMIT, target_fd_limit};

        #[test]
        fn raises_a_low_inherited_soft_limit() {
            // The soft limit a macOS app inherits from a Finder launch.
            assert_eq!(target_fd_limit(256, 1 << 20), Some(DESIRED_FD_LIMIT));
        }

        #[test]
        fn stops_at_the_hard_limit() {
            assert_eq!(target_fd_limit(256, 1024), Some(1024));
        }

        #[test]
        fn asks_for_the_full_amount_when_the_hard_limit_is_infinite() {
            assert_eq!(
                target_fd_limit(256, libc::RLIM_INFINITY),
                Some(DESIRED_FD_LIMIT)
            );
        }

        #[test]
        fn skips_a_soft_limit_that_already_suffices() {
            assert_eq!(target_fd_limit(DESIRED_FD_LIMIT, 1 << 20), None);
            assert_eq!(target_fd_limit(1 << 20, 1 << 20), None);
        }

        #[test]
        fn never_lowers_a_soft_limit_above_the_hard_limit() {
            // Nonsensical, but a silent lowering would be worse than a no-op.
            assert_eq!(target_fd_limit(2048, 1024), None);
        }
    }
}
