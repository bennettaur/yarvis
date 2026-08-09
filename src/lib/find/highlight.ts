/**
 * Painting find matches through the CSS Custom Highlight API. Nothing here
 * touches the DOM: the ranges are handed to the browser and styled by the
 * `::highlight()` rules in `index.css`. That matters because the views being
 * searched are React-owned — wrapping matches in `<mark>` elements would fight
 * the next render — and because a highlight pass can't retrigger the mutation
 * observer that drives re-matching.
 */

/** Registry keys, paired with the `::highlight()` rules in `index.css`. */
const ALL_MATCHES = "yarvis-find";
const ACTIVE_MATCH = "yarvis-find-active";

/**
 * The API is WebKit 17.2 and newer. Where it is missing, find still counts
 * matches and scrolls to them; only the tinting is lost.
 */
export function highlightsSupported(): boolean {
  return typeof CSS !== "undefined" && "highlights" in CSS && typeof Highlight === "function";
}

/** Tints every match, with the one at `activeIndex` picked out from the rest. */
export function showMatches(ranges: Range[], activeIndex: number): void {
  if (!highlightsSupported()) return;

  const active = ranges[activeIndex];
  const rest = ranges.filter((_, index) => index !== activeIndex);
  CSS.highlights.set(ALL_MATCHES, new Highlight(...rest));
  if (active) CSS.highlights.set(ACTIVE_MATCH, new Highlight(active));
  else CSS.highlights.delete(ACTIVE_MATCH);
}

export function clearMatches(): void {
  if (!highlightsSupported()) return;
  CSS.highlights.delete(ALL_MATCHES);
  CSS.highlights.delete(ACTIVE_MATCH);
}

/**
 * Brings a match into view. A range has no scroll behaviour of its own, so this
 * scrolls the element the match starts in — close enough to land the match on
 * screen for the paragraph-sized blocks the app renders.
 */
export function scrollToRange(range: Range): void {
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  if (element && typeof element.scrollIntoView === "function") {
    element.scrollIntoView({ block: "center", inline: "nearest" });
  }
}
