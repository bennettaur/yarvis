import type { MatchRange } from "./matches";

/**
 * Flattens a subtree's on-screen text into one string, keeping enough
 * bookkeeping to turn an offset in that string back into a DOM `Range`. This is
 * what lets find work over whatever a view happens to have rendered without any
 * view opting in.
 */

/** Where one text node's contents landed in the flattened text. */
interface TextSegment {
  node: Text;
  start: number;
}

export interface PageText {
  text: string;
  segments: TextSegment[];
}

/** Elements that carry no on-screen text of their own. */
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "TITLE"]);

/**
 * Elements whose text reads as part of the surrounding line. Anything else
 * starts a new line in the flattened text, so a word ending one paragraph and a
 * word starting the next can't join into a match that appears nowhere on screen.
 */
const INLINE_TAGS = new Set([
  "A",
  "ABBR",
  "B",
  "BDI",
  "BDO",
  "CITE",
  "CODE",
  "DATA",
  "DEL",
  "DFN",
  "EM",
  "I",
  "INS",
  "KBD",
  "MARK",
  "Q",
  "S",
  "SAMP",
  "SMALL",
  "SPAN",
  "STRONG",
  "SUB",
  "SUP",
  "TIME",
  "U",
  "VAR",
]);

/**
 * Whether an element's text is on screen and worth searching. Results are
 * memoised per index pass because the answer folds in every ancestor's answer,
 * and a deep tree would otherwise re-walk the same spine for every text node.
 */
function isSearchable(element: Element, root: Element, cache: Map<Element, boolean>): boolean {
  const cached = cache.get(element);
  if (cached !== undefined) return cached;

  let searchable = true;
  if (element instanceof HTMLElement && element.hidden) {
    searchable = false;
  } else if (element.getAttribute("aria-hidden") === "true") {
    // Decorative by the author's own account — icons, spacer glyphs.
    searchable = false;
  } else {
    const style = element.ownerDocument.defaultView?.getComputedStyle(element);
    if (style && (style.display === "none" || style.visibility === "hidden")) searchable = false;
  }

  if (searchable && element !== root) {
    const parent = element.parentElement;
    if (parent) searchable = isSearchable(parent, root, cache);
  }

  cache.set(element, searchable);
  return searchable;
}

/** The nearest ancestor that starts its own line, i.e. the text node's block. */
function blockAncestor(node: Text, root: Element): Element | null {
  let element = node.parentElement;
  while (element && element !== root && INLINE_TAGS.has(element.tagName)) {
    element = element.parentElement;
  }
  return element;
}

/** Flattens the visible text under `root`, newest state each call — never cached across renders. */
export function indexPageText(root: Element): PageText {
  const cache = new Map<Element, boolean>();
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || node.textContent === "") return NodeFilter.FILTER_REJECT;
      if (SKIPPED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      return isSearchable(parent, root, cache)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });

  const segments: TextSegment[] = [];
  let text = "";
  let previousBlock: Element | null = null;

  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const textNode = node as Text;
    const block = blockAncestor(textNode, root);
    if (segments.length > 0 && block !== previousBlock) text += "\n";
    segments.push({ node: textNode, start: text.length });
    text += textNode.data;
    previousBlock = block;
  }

  return { text, segments };
}

/** The segment covering `offset`, or -1 when it falls on a block separator. */
function segmentIndexAt(segments: TextSegment[], offset: number): number {
  let low = 0;
  let high = segments.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const segment = segments[mid];
    if (offset < segment.start) high = mid - 1;
    else if (offset >= segment.start + segment.node.data.length) low = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * The DOM range a match occupies. Returns null if the match no longer maps onto
 * live text nodes, which happens when the page changed between indexing and
 * this call.
 */
export function rangeFor(page: PageText, match: MatchRange): Range | null {
  if (match.end <= match.start) return null;

  const startIndex = segmentIndexAt(page.segments, match.start);
  const endIndex = segmentIndexAt(page.segments, match.end - 1);
  if (startIndex === -1 || endIndex === -1) return null;

  const startSegment = page.segments[startIndex];
  const endSegment = page.segments[endIndex];
  const range = startSegment.node.ownerDocument.createRange();
  range.setStart(startSegment.node, match.start - startSegment.start);
  range.setEnd(endSegment.node, match.end - endSegment.start);
  return range;
}
