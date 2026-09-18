/** How long a jump keeps its target pinned while the review around it settles. */
const JUMP_HOLD_MS = 1500;

/** Input that means the reader has started scrolling on their own. */
const READER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

const PANE_SELECTOR = "[data-pr-scroll]";

/** The running hold's release, per scroll pane, so a second jump replaces the first. */
const holds = new WeakMap<Element, () => void>();

let runningHolds = 0;
const pauseListeners = new Set<() => void>();

/**
 * Whether a jump is holding its landing, which pauses expand-on-approach (see
 * {@link useExpandOnApproach}). A hold corrects the pane's scroll, and every
 * correction can bring more collapsed files within reach — each one opening is
 * fresh drift for the hold to chase. They open when it ends instead.
 *
 * Global rather than per-pane because only `PrDetailView` marks a pane, so at
 * most one hold can ever be running.
 */
export function expansionPaused(): boolean {
  return runningHolds > 0;
}

/** Subscribes to {@link expansionPaused} changes. */
export function subscribeExpansionPause(listener: () => void): () => void {
  pauseListeners.add(listener);
  return () => {
    pauseListeners.delete(listener);
  };
}

/**
 * Keeps `el` at its current offset inside the review scroll pane for `holdMs`,
 * or until the reader scrolls on their own or `el` leaves the page.
 *
 * A jump lands before the review has settled: an open file's diff arrives after
 * its fetch, and files can open above the target where it sits too close to the
 * end of the review to reach the top of the pane. Each grows the page above the
 * target while the scroll position stays put, so the target drifts from where
 * the jump put it. The drift is corrected every frame rather than left to the
 * browser's scroll anchoring, which the webview can't be relied on to provide.
 *
 * Does nothing outside a `data-pr-scroll` pane, which only `PrDetailView` sets.
 *
 * Returns a function that ends the hold early.
 */
export function holdInPlace(el: HTMLElement, holdMs = JUMP_HOLD_MS): () => void {
  const pane = el.closest<HTMLElement>(PANE_SELECTOR);
  if (!pane) return () => {};
  holds.get(pane)?.();

  const offset = () => el.getBoundingClientRect().top - pane.getBoundingClientRect().top;
  const anchor = offset();
  const deadline = performance.now() + holdMs;
  let frame = 0;
  let released = false;

  const release = () => {
    if (released) return;
    released = true;
    cancelAnimationFrame(frame);
    for (const type of READER_SCROLL_EVENTS) pane.removeEventListener(type, release);
    if (holds.get(pane) === release) holds.delete(pane);
    runningHolds--;
    for (const listener of pauseListeners) listener();
  };
  const tick = () => {
    // A detached target measures at the viewport's top forever, which would
    // walk the pane upward every frame until the deadline.
    if (!el.isConnected || performance.now() >= deadline) {
      release();
      return;
    }
    const drift = offset() - anchor;
    if (Math.abs(drift) >= 1) pane.scrollTop += drift;
    frame = requestAnimationFrame(tick);
  };

  for (const type of READER_SCROLL_EVENTS) {
    pane.addEventListener(type, release, { passive: true });
  }
  holds.set(pane, release);
  runningHolds++;
  for (const listener of pauseListeners) listener();
  frame = requestAnimationFrame(tick);
  return release;
}

/** Ends whatever hold is running in `el`'s scroll pane, before a new scroll starts. */
export function releaseHold(el: Element): void {
  const pane = el.closest(PANE_SELECTOR);
  if (pane) holds.get(pane)?.();
}
