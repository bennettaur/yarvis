/**
 * Self-termination when the sidecar is orphaned.
 *
 * The Rust core kills the sidecar on a clean shutdown (`kill_on_drop`), but a
 * crash or force-quit of the app can't run that cleanup, leaving the sidecar
 * running. A leaked sidecar keeps polling Telegram, which then collides (HTTP
 * 409) with the next app session's sidecar — two pollers fighting indefinitely.
 * Watching the parent pid lets an orphan exit on its own so only one sidecar is
 * ever live.
 */

/** True once the process has been reparented (its launching parent died). */
export function isOrphaned(initialPpid: number, currentPpid: number): boolean {
  return currentPpid !== initialPpid;
}

/**
 * Exits the process if its launching parent goes away. Returns a stop function
 * (mainly for tests); in normal use it runs for the process lifetime and does
 * not keep the event loop alive on its own.
 */
export function watchParentProcess(intervalMs = 5000): () => void {
  const initialPpid = process.ppid;
  const timer = setInterval(() => {
    if (isOrphaned(initialPpid, process.ppid)) {
      console.error("[sidecar] parent process gone; exiting to avoid an orphaned instance");
      process.exit(0);
    }
  }, intervalMs);
  // Don't hold the process open solely for this watcher.
  timer.unref?.();
  return () => clearInterval(timer);
}
