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

/**
 * The two highlights, registered once and then mutated in place for the rest of
 * the session.
 *
 * Handing the registry a *replacement* `Highlight` under the same key is what an
 * earlier version did, and it left matches from the previous query painted:
 * swapping the entry does not reliably invalidate what the old one had already
 * drawn. Editing a registered highlight's contents is the path the browser
 * watches, so `clear()` + `add()` repaints — and it skips rebuilding a set of up
 * to two thousand ranges on every keystroke besides.
 */
let layers: { all: Highlight; active: Highlight } | null = null;

function highlightLayers(): { all: Highlight; active: Highlight } | null {
  if (!highlightsSupported()) return null;
  if (!layers) {
    layers = { all: new Highlight(), active: new Highlight() };
    CSS.highlights.set(ALL_MATCHES, layers.all);
    CSS.highlights.set(ACTIVE_MATCH, layers.active);
  }
  return layers;
}

/** Tints every match, with the one at `activeIndex` picked out from the rest. */
export function showMatches(ranges: Range[], activeIndex: number): void {
  const highlights = highlightLayers();
  if (!highlights) return;

  highlights.all.clear();
  highlights.active.clear();
  ranges.forEach((range, index) => {
    if (index === activeIndex) highlights.active.add(range);
    else highlights.all.add(range);
  });
}

export function clearMatches(): void {
  // Only touches highlights that were registered — nothing to clear otherwise,
  // and registering a pair just to empty them would be busywork.
  layers?.all.clear();
  layers?.active.clear();
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
