import { type RefObject, useCallback, useEffect, useRef, useState } from "react";
import { clearMatches, scrollToRange, showMatches } from "./highlight";
import { matchRanges } from "./matches";
import { indexPageText, rangeFor } from "./pageText";

/**
 * Ceiling on how many matches are tracked. A one-letter query against a long
 * transcript can hit tens of thousands of times, and past a couple of thousand
 * the exact number is no longer what the user is after — the count is reported
 * as "and more" instead.
 */
export const MAX_MATCHES = 2000;

/** How long the page settles after a DOM change before matches are recomputed. */
const RESCAN_DEBOUNCE_MS = 200;

/** State and actions the find bar renders and drives. */
export interface FindController {
  open: boolean;
  query: string;
  caseSensitive: boolean;
  /** How many matches are tracked — capped at {@link MAX_MATCHES}. */
  count: number;
  /** Zero-based index of the highlighted match, or -1 when there are none. */
  activeIndex: number;
  /** True when the page holds more matches than are tracked. */
  truncated: boolean;
  /** Bumped every time Cmd+F is pressed, so the bar re-focuses when already open. */
  focusToken: number;
  setQuery: (query: string) => void;
  toggleCaseSensitive: () => void;
  next: () => void;
  previous: () => void;
  close: () => void;
}

/**
 * The find-on-page controller: Cmd/Ctrl+F opens the bar, matches are tracked
 * against whatever `rootRef` currently renders, and Cmd/Ctrl+G (Shift to go
 * back) steps between them.
 *
 * The key listener runs in the capture phase for the same reason the tab
 * shortcuts do — the Terminal's xterm would otherwise swallow the combo before
 * the window sees it.
 */
export function useFind(rootRef: RefObject<HTMLElement | null>): FindController {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [count, setCount] = useState(0);
  const [truncated, setTruncated] = useState(false);
  const [active, setActive] = useState(0);
  const [focusToken, setFocusToken] = useState(0);
  /** Bumped on every rescan so the paint effect re-runs even when the count is unchanged. */
  const [revision, setRevision] = useState(0);

  const ranges = useRef<Range[]>([]);
  /** Read the open state from the key listener without re-subscribing. */
  const openRef = useRef(open);
  useEffect(() => {
    openRef.current = open;
  }, [open]);

  const rescan = useCallback(() => {
    const root = rootRef.current;
    if (!root || query === "") {
      ranges.current = [];
      setCount(0);
      setTruncated(false);
      setRevision((n) => n + 1);
      return;
    }

    const page = indexPageText(root);
    const found = matchRanges(page.text, query, caseSensitive);
    ranges.current = found
      .slice(0, MAX_MATCHES)
      .map((match) => rangeFor(page, match))
      .filter((range): range is Range => range !== null);
    setCount(ranges.current.length);
    setTruncated(found.length > MAX_MATCHES);
    setRevision((n) => n + 1);
  }, [rootRef, query, caseSensitive]);

  // Re-match on every query change, and keep following the page as it changes
  // underneath — chat streams in, terminal output scrolls — for as long as the
  // bar is open. Highlighting doesn't mutate the DOM, so observing our own
  // output can't loop.
  useEffect(() => {
    if (!open) return;
    rescan();

    const root = rootRef.current;
    if (!root) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const observer = new MutationObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(rescan, RESCAN_DEBOUNCE_MS);
    });
    observer.observe(root, { subtree: true, childList: true, characterData: true });
    return () => {
      clearTimeout(timer);
      observer.disconnect();
    };
  }, [open, rescan, rootRef]);

  // A new query starts over from the first match.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the reset is the effect
  useEffect(() => {
    setActive(0);
  }, [query, caseSensitive]);

  // A page that changed under us can leave the selection past the last match.
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);

  /** What the last scroll was for, so a background rescan doesn't yank the view. */
  const scrolledTo = useRef("");

  // biome-ignore lint/correctness/useExhaustiveDependencies: repaint on every rescan
  useEffect(() => {
    if (!open) return;
    showMatches(ranges.current, activeIndex);

    const target = `${caseSensitive ? "case" : "any"}:${activeIndex}:${query}`;
    if (target === scrolledTo.current) return;
    scrolledTo.current = target;
    const range = ranges.current[activeIndex];
    if (range) scrollToRange(range);
  }, [open, activeIndex, revision, query, caseSensitive]);

  useEffect(() => {
    if (open) return;
    clearMatches();
    ranges.current = [];
    scrolledTo.current = "";
  }, [open]);

  // Highlights live in a document-level registry, so unmounting without clearing
  // would leave the last search tinted on screen.
  useEffect(() => clearMatches, []);

  const next = useCallback(() => {
    setActive((current) => (count === 0 ? 0 : (Math.min(current, count - 1) + 1) % count));
  }, [count]);

  const previous = useCallback(() => {
    setActive((current) => (count === 0 ? 0 : (Math.min(current, count - 1) + count - 1) % count));
  }, [count]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      const key = e.key.toLowerCase();

      if (key === "f" && !e.shiftKey) {
        e.preventDefault();
        setOpen(true);
        setFocusToken((n) => n + 1);
        return;
      }
      // Cmd+G repeats the search from wherever focus is, which is the point of
      // it — but only once there is a search to repeat.
      if (key === "g" && openRef.current) {
        e.preventDefault();
        if (e.shiftKey) previous();
        else next();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [next, previous]);

  const toggleCaseSensitive = useCallback(() => setCaseSensitive((on) => !on), []);
  const close = useCallback(() => setOpen(false), []);

  return {
    open,
    query,
    caseSensitive,
    count,
    activeIndex,
    truncated,
    focusToken,
    setQuery,
    toggleCaseSensitive,
    next,
    previous,
    close,
  };
}
