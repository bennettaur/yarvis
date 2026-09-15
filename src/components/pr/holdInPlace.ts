/** How long a jump keeps its target pinned while the review around it settles. */
export const HOLD_MS = 1500;

/** Input that means the reader has started scrolling on their own. */
const READER_SCROLL_EVENTS = ["wheel", "touchmove", "keydown", "pointerdown"] as const;

const PANE_SELECTOR = "[data-pr-scroll]";

/** The running hold's release, per scroll pane, so a second jump replaces the first. */
const holds = new WeakMap<Element, () => void>();

/**
 * Keeps `el` at its current offset inside the review scroll pane for `holdMs`,
 * or until the reader scrolls on their own.
 *
 * A jump lands before the review has settled: collapsed files visible above the
 * target open as they come into reach, and an open file's diff arrives after its
 * fetch. Each grows the page above the target while the scroll position stays
 * put, which is how a click on a file near the end of a review landed somewhere
 * else. The drift is corrected every frame rather than left to the browser's
 * scroll anchoring, which the webview can't be relied on to provide.
 *
 * Returns a function that ends the hold early.
 */
export function holdInPlace(el: HTMLElement, holdMs = HOLD_MS): () => void {
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
    const drift = offset() - anchor;
    if (Math.abs(drift) >= 1) pane.scrollTop += drift;
    if (performance.now() >= deadline) {
      release();
      return;
    }
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
