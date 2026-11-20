/**
 * The loop's handles, in a module of their own so the chat tools and routes
 * can reach the loop without importing it (the loop runs chat turns, so it
 * imports the tools that would import it).
 */

let wakeLoop: (() => void) | null = null;
let abortPass: (() => void) | null = null;
let movePassStopTime: ((stopAt: Date | null) => void) | null = null;

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

let rescheduleLoop: (() => void) | null = null;

/**
 * Has the loop re-read the run's stop time without running a pass, so a stop
 * time set while it sleeps still stops the run on time.
 */
export function rescheduleHeadsDown(): void {
  rescheduleLoop?.();
}

/** Called by the loop when it starts, and with null when it stops. */
export function setRescheduleHandler(handler: (() => void) | null): void {
  rescheduleLoop = handler;
}

/**
 * Stops the pass in flight, for when the user turns heads-down mode off: it
 * must not go on acting for the rest of a pass that could last many minutes.
 */
export function abortHeadsDownPass(): void {
  abortPass?.();
}

/** Called by a pass with its abort while it runs, and with null when it ends. */
export function setPassAbort(handler: (() => void) | null): void {
  abortPass = handler;
}

/**
 * Moves the stop time of the pass in flight, so a stop time set, moved or
 * cleared while it runs takes effect before it ends.
 */
export function updatePassStopTime(stopAt: Date | null): void {
  movePassStopTime?.(stopAt);
}

/** Called by a pass with its stop-time handler while it runs, and with null when it ends. */
export function setPassStopTimeHandler(handler: ((stopAt: Date | null) => void) | null): void {
  movePassStopTime = handler;
}
