/**
 * The loop's wake-up hook, in a module of its own so the chat tools and routes
 * can wake the loop without importing it (the loop runs chat turns, so it
 * imports the tools that would import it).
 */

let wakeLoop: (() => void) | null = null;

/**
 * Wakes the loop for a pass now, rather than when its sleep ends: the user
 * started a run, sent a message or answered. A no-op on an instance that
 * isn't running the loop, which picks the change up when its sleep ends.
 */
export function wakeHeadsDown(): void {
  wakeLoop?.();
}

/** Called by the loop when it starts, and with null when it stops. */
export function setWakeHandler(handler: (() => void) | null): void {
  wakeLoop = handler;
}
