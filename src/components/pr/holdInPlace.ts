/** How long a jump keeps its target pinned while the review around it settles. */
const JUMP_HOLD_MS = 1500;

/** Input that means the reader has started scrolling on their own. */
const READER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

const PANE_SELECTOR = "[data-pr-scroll]";

/** The running hold's release, per scroll pane, so a second jump replaces the first. */
const holds = new WeakMap<Element, () => void>();

/**
 * Keeps `el` at its current offset inside the review scroll pane for `holdMs`,
 * or until the reader scrolls on their own or `el` leaves the page.
 *
 * A jump lands before the review has settled: collapsed files visible above the
 * target open as they come into reach, and an open file's diff arrives after its
 * fetch. Each grows the page above the target while the scroll position stays
 * put, so the target drifts from where the jump put it. The drift is corrected
 * every frame rather than left to the browser's scroll anchoring, which the
 * webview can't be relied on to provide.
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

  const release = () => {
    cancelAnimationFrame(frame);
    for (const type of READER_SCROLL_EVENTS) pane.removeEventListener(type, release);
    if (holds.get(pane) === release) holds.delete(pane);
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
  frame = requestAnimationFrame(tick);
  return release;
}

/** Ends whatever hold is running in `el`'s scroll pane, before a new scroll starts. */
export function releaseHold(el: Element): void {
  const pane = el.closest(PANE_SELECTOR);
  if (pane) holds.get(pane)?.();
}
