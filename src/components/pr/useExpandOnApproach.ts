import { type RefObject, useEffect, useRef } from "react";

/** How far below the review pane a file starts opening, in pixels. */
export const EXPAND_AHEAD_PX = 600;

/**
 * Runs `onApproach` once, when the referenced element comes within reach of the
 * reader, so a review can pull content in ahead of them instead of leaving a
 * trail of collapsed files to click through.
 *
 * The observer roots on the review scroll pane (`data-pr-scroll`) rather than
 * the default viewport root: elements past the pane's bottom edge are clipped
 * by it and never report as intersecting against the viewport, so no
 * `rootMargin` would reach them. The margin extends downward only — expanding a
 * file the reader has already scrolled past would grow the page above them and
 * shove the line they were reading off screen.
 *
 * Pass `enabled: false` once the element has nothing left to reveal; the
 * observer is torn down rather than left running for the rest of the review.
 */
export function useExpandOnApproach(
  ref: RefObject<HTMLElement | null>,
  enabled: boolean,
  onApproach: () => void,
): void {
  // Read through a ref so a caller's inline callback doesn't tear down and
  // rebuild the observer on every render.
  const handler = useRef(onApproach);
  handler.current = onApproach;

  useEffect(() => {
    const el = ref.current;
    // happy-dom (the test environment) has no IntersectionObserver, and neither
    // does any environment without a viewport. Approach is a scroll affordance;
    // with no scrolling there is nothing to respond to.
    if (!enabled || !el || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        observer.disconnect();
        handler.current();
      },
      {
        root: el.closest("[data-pr-scroll]"),
        rootMargin: `0px 0px ${EXPAND_AHEAD_PX}px 0px`,
      },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref, enabled]);
}
