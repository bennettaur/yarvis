/** A half-open `[start, end)` span of the flattened page text. */
export interface MatchRange {
  start: number;
  end: number;
}

/**
 * Lowercases text without changing its length, so an offset into the folded
 * string still addresses the same character in the original. A handful of code
 * points (ẞ, İ) lowercase into more than one character; those are left alone
 * rather than shifting every offset that follows them.
 */
function foldCase(text: string): string {
  let folded = "";
  for (const char of text) {
    const lower = char.toLowerCase();
    folded += lower.length === char.length ? lower : char;
  }
  return folded;
}

/**
 * Every non-overlapping occurrence of `query` in `text`, in document order.
 * Case-insensitive unless `caseSensitive` is set. Pure, so the offset math is
 * testable without a DOM.
 */
export function matchRanges(text: string, query: string, caseSensitive = false): MatchRange[] {
  if (query === "") return [];

  const haystack = caseSensitive ? text : foldCase(text);
  const needle = caseSensitive ? query : foldCase(query);
  const ranges: MatchRange[] = [];

  let from = 0;
  for (;;) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) break;
    const end = start + needle.length;
    ranges.push({ start, end });
    from = end;
  }
  return ranges;
}
