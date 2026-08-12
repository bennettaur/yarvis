import type { DiffRow } from "./diff";

/**
 * Reveals the unchanged code a patch leaves out.
 *
 * A unified diff only carries a few lines of context around each hunk, so
 * reviewing a change often means guessing at what surrounds it. Given the head
 * file's full text, this module works out which stretches of that file the patch
 * omitted (the "gaps") and splices the requested ones back in as ordinary
 * context rows. Expanding every gap of a file yields the whole file with its
 * changes still highlighted in place.
 */

/** Lines revealed per click, at whichever end of the gap was clicked. */
export const EXPAND_STEP = 20;

/** Splits file content into lines, without a phantom trailing empty line. */
export function toFileLines(content: string): string[] {
  if (content === "") return [];
  return content.replace(/\n$/, "").split("\n");
}

/** One hunk's footprint in both files, taken from its `@@` header. */
export interface HunkSpan {
  /** Index of the header row in the parsed rows. */
  headerIndex: number;
  /** Index one past the hunk's last row. */
  endIndex: number;
  leftStart: number;
  leftEnd: number;
  rightStart: number;
  rightEnd: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * The first new-file line a hunk header names, or null if it isn't one. Lets a
 * consumer holding only rendered rows recover a hunk's position — which is the
 * only place a deletion-only hunk's location is recorded, since none of its
 * rows carry a right-side line.
 */
export function hunkRightStart(text: string): number | null {
  const match = text.match(HUNK_HEADER);
  return match ? Number(match[3]) : null;
}

/**
 * Locates each hunk and the range of each file it covers.
 *
 * A hunk with a zero line count on one side (a pure insertion or a pure
 * deletion) covers nothing there. Its header still names the line the change
 * sits *after*, so the range is deliberately built empty — `start` one past
 * `end` — which makes the gaps on either side land in the right place without
 * the callers below needing a special case.
 */
export function hunkSpans(rows: DiffRow[]): HunkSpan[] {
  const spans: HunkSpan[] = [];
  rows.forEach((row, index) => {
    if (row.kind !== "hunk") return;
    const match = row.text.match(HUNK_HEADER);
    if (!match) return;
    const leftStart = Number(match[1]);
    const leftCount = match[2] === undefined ? 1 : Number(match[2]);
    const rightStart = Number(match[3]);
    const rightCount = match[4] === undefined ? 1 : Number(match[4]);
    if (spans.length > 0) spans[spans.length - 1]!.endIndex = index;
    spans.push({
      headerIndex: index,
      endIndex: rows.length,
      leftStart: leftCount === 0 ? leftStart + 1 : leftStart,
      leftEnd: leftCount === 0 ? leftStart : leftStart + leftCount - 1,
      rightStart: rightCount === 0 ? rightStart + 1 : rightStart,
      rightEnd: rightCount === 0 ? rightStart : rightStart + rightCount - 1,
    });
  });
  return spans;
}

/** A stretch of the head file that the patch omitted. */
export interface Gap {
  /** Position in the gap list; the key expansion state is recorded against. */
  index: number;
  /** First and last right-file line the gap covers, inclusive. */
  from: number;
  to: number;
  /** Right-file line minus left-file line throughout this gap. */
  lineOffset: number;
}

/**
 * The stretches of the head file left out of the patch: before the first hunk,
 * between consecutive hunks, and after the last. Gaps that would be empty (two
 * hunks that abut) are dropped, so an index here is always a real gap.
 *
 * The hunk headers alone fix every gap except the trailing one, whose length
 * depends on how far the file runs past the last hunk. Pass `totalLines: 0`
 * when the content hasn't loaded and that final gap is simply left out — which
 * is what lets the markers appear before anything has been fetched.
 */
export function gapsBetween(spans: HunkSpan[], totalLines: number): Gap[] {
  const gaps: Gap[] = [];
  const push = (from: number, to: number, lineOffset: number) => {
    if (from > to) return;
    gaps.push({ index: gaps.length, from, to, lineOffset });
  };

  if (spans.length === 0) {
    push(1, totalLines, 0);
    return gaps;
  }
  // Above the first hunk the two files have not diverged yet, so their
  // numbering still agrees.
  push(1, spans[0]!.rightStart - 1, 0);
  for (let i = 0; i < spans.length - 1; i++) {
    const before = spans[i]!;
    push(before.rightEnd + 1, spans[i + 1]!.rightStart - 1, before.rightEnd - before.leftEnd);
  }
  const last = spans[spans.length - 1]!;
  push(last.rightEnd + 1, totalLines, last.rightEnd - last.leftEnd);
  return gaps;
}

/**
 * How much of a gap has been revealed, counted inward from each end. A gap sits
 * between two hunks, and a reader following the code downward wants the lines
 * just below the hunk above, while one tracing a call upward wants the lines
 * just above the hunk below — so both ends open independently and the remaining
 * hidden stretch stays in the middle.
 */
export interface GapExpansion {
  top: number;
  bottom: number;
}

export type Expansions = Map<number, GapExpansion>;

/** Rows to render: real patch rows, plus a marker for each still-hidden gap. */
export type ExpandedRow = { kind: "row"; row: DiffRow } | { kind: "gap"; gap: Gap; hidden: number };

function contextRow(text: string, rightLine: number, lineOffset: number): DiffRow {
  // Rebuilt in the patch's own shape, marker column and all, so a synthesized
  // line is indistinguishable from one the provider sent and every renderer
  // handles it without knowing where it came from.
  return { kind: "context", text: ` ${text}`, rightLine, leftLine: rightLine - lineOffset };
}

/**
 * Splices the revealed parts of each gap into the patch rows.
 *
 * `fileLines` is the head file, empty until it loads. The markers still render
 * in that state — their sizes come from the hunk headers — so the reader can
 * ask for context before anything has been fetched; the expansion itself is
 * held back until there are lines to show, rather than briefly collapsing a
 * marker into nothing.
 */
export function expandRows(
  rows: DiffRow[],
  fileLines: string[],
  expansions: Expansions,
): ExpandedRow[] {
  const loaded = fileLines.length > 0;
  const spans = hunkSpans(rows);
  const gaps = gapsBetween(spans, fileLines.length);
  const out: ExpandedRow[] = [];
  const hunkStarts = new Map(spans.map((span) => [span.headerIndex, span.rightStart]));

  // The last right-file line put out so far, which is what tells a hunk header
  // whether the reader skipped anything to reach it.
  let lastRight = 0;
  const emitRow = (row: DiffRow) => {
    if (row.rightLine != null) lastRight = row.rightLine;
    out.push({ kind: "row", row });
  };

  const emitGap = (gap: Gap) => {
    const size = gap.to - gap.from + 1;
    const state = loaded ? expansions.get(gap.index) : undefined;
    // Clamp so the two ends can never claim more than the gap holds; once they
    // meet, the whole gap is revealed and no marker is left in the middle.
    const top = Math.min(state?.top ?? 0, size);
    const bottom = Math.min(state?.bottom ?? 0, size - top);
    const hidden = size - top - bottom;

    const emitLines = (from: number, to: number) => {
      for (let line = from; line <= to; line++) {
        const text = fileLines[line - 1];
        if (text === undefined) continue;
        emitRow(contextRow(text, line, gap.lineOffset));
      }
    };

    emitLines(gap.from, gap.from + top - 1);
    if (hidden > 0) out.push({ kind: "gap", gap, hidden });
    emitLines(gap.to - bottom + 1, gap.to);
  };

  // A gap sits before the hunk of the same index; the final gap trails them all.
  const emitRows = (from: number, to: number) => {
    for (let i = from; i < to; i++) {
      // A `@@` header says where the patch jumped to. Once the line it names
      // is sitting directly above it, nothing was jumped over and the header
      // only repeats the numbers already down the side — which is every header
      // in the whole-file view. Headers stay while the file's text is
      // unloaded: there they are the sole record of where each hunk sits.
      const start = hunkStarts.get(i);
      if (loaded && start !== undefined && start === lastRight + 1) continue;
      emitRow(rows[i]!);
    }
  };

  let gapCursor = 0;
  const nextGapBefore = (rightStart: number) => {
    while (gapCursor < gaps.length && gaps[gapCursor]!.from < rightStart) {
      emitGap(gaps[gapCursor]!);
      gapCursor++;
    }
  };

  // Rows before the first hunk (a raw `git diff`'s file header is already
  // stripped by `parsePatch`, so in practice there are none) stay put.
  emitRows(0, spans[0]?.headerIndex ?? rows.length);
  for (const span of spans) {
    nextGapBefore(span.rightStart);
    emitRows(span.headerIndex, span.endIndex);
  }
  while (gapCursor < gaps.length) {
    emitGap(gaps[gapCursor]!);
    gapCursor++;
  }
  return out;
}

/** Reveals `EXPAND_STEP` more lines at one end of a gap. */
export function expandGap(expansions: Expansions, gap: Gap, edge: "top" | "bottom"): Expansions {
  const next = new Map(expansions);
  const current = next.get(gap.index) ?? { top: 0, bottom: 0 };
  next.set(gap.index, { ...current, [edge]: current[edge] + EXPAND_STEP });
  return next;
}

/** Reveals a gap in full. */
export function expandGapFully(expansions: Expansions, gap: Gap): Expansions {
  const next = new Map(expansions);
  next.set(gap.index, { top: gap.to - gap.from + 1, bottom: 0 });
  return next;
}

/**
 * Reveals every gap, turning the diff into the whole file with its changes
 * still highlighted in place.
 */
export function expandAllGaps(rows: DiffRow[], totalLines: number): Expansions {
  const next: Expansions = new Map();
  for (const gap of gapsBetween(hunkSpans(rows), totalLines)) {
    next.set(gap.index, { top: gap.to - gap.from + 1, bottom: 0 });
  }
  return next;
}
