import { describe, expect, it } from "bun:test";
import { parsePatch } from "./diff";
import {
  EXPAND_STEP,
  type Expansions,
  expandAllGaps,
  expandGap,
  expandGapFully,
  expandRows,
  gapsBetween,
  hunkSpans,
  toFileLines,
} from "./expand";

/** A 10-line file, so gaps have room on both sides of a mid-file hunk. */
const FILE = toFileLines(["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].join("\n"));

/** Renders the result compactly: `context@line` for rows, `gap:n` for markers. */
function shape(rows: ReturnType<typeof expandRows>): string[] {
  return rows.map((r) =>
    r.kind === "gap" ? `gap:${r.hidden}` : `${r.row.kind}@${r.row.rightLine ?? "-"}`,
  );
}

describe("toFileLines", () => {
  it("does not invent a trailing empty line", () => {
    expect(toFileLines("a\nb\n")).toEqual(["a", "b"]);
    expect(toFileLines("a\nb")).toEqual(["a", "b"]);
  });

  it("treats empty content as no lines", () => {
    expect(toFileLines("")).toEqual([]);
  });

  // A file that is genuinely one blank line still has a line in it.
  it("keeps a single blank line", () => {
    expect(toFileLines("\n")).toEqual([""]);
  });
});

describe("hunkSpans", () => {
  it("reads both files' ranges off the header", () => {
    const rows = parsePatch(["@@ -3,2 +5,3 @@", " a", "+b", " c"].join("\n"));
    expect(hunkSpans(rows)).toEqual([
      { headerIndex: 0, endIndex: 4, leftStart: 3, leftEnd: 4, rightStart: 5, rightEnd: 7 },
    ]);
  });

  // `@@ -5,3 +4,0 @@` deletes three lines and adds none. The header names the
  // line the deletion sits after, so the right-side range must come out empty
  // rather than covering line 4, which belongs to the gap above it.
  it("gives a pure deletion an empty range on the right", () => {
    const rows = parsePatch(["@@ -5,3 +4,0 @@", "-a", "-b", "-c"].join("\n"));
    const [span] = hunkSpans(rows);
    expect(span!.rightStart).toBe(5);
    expect(span!.rightEnd).toBe(4);
  });

  it("defaults an omitted count to one line", () => {
    const rows = parsePatch(["@@ -3 +5 @@", "-a", "+b"].join("\n"));
    const [span] = hunkSpans(rows);
    expect(span).toMatchObject({ leftStart: 3, leftEnd: 3, rightStart: 5, rightEnd: 5 });
  });

  it("ends each hunk where the next one starts", () => {
    const rows = parsePatch(["@@ -1,1 +1,1 @@", "+a", "@@ -5,1 +5,1 @@", "+b"].join("\n"));
    const spans = hunkSpans(rows);
    expect(spans[0]).toMatchObject({ headerIndex: 0, endIndex: 2 });
    expect(spans[1]).toMatchObject({ headerIndex: 2, endIndex: 4 });
  });
});

describe("gapsBetween", () => {
  it("finds the stretches above, between, and below the hunks", () => {
    const rows = parsePatch(["@@ -3,1 +3,1 @@", "+c", "@@ -7,1 +7,1 @@", "+g"].join("\n"));
    expect(gapsBetween(hunkSpans(rows), 10)).toEqual([
      { index: 0, from: 1, to: 2, lineOffset: 0 },
      { index: 1, from: 4, to: 6, lineOffset: 0 },
      { index: 2, from: 8, to: 10, lineOffset: 0 },
    ]);
  });

  // Two hunks that touch leave nothing between them, and a hunk starting at
  // line 1 leaves nothing above it. Neither should produce a gap to click.
  it("drops empty gaps", () => {
    const rows = parsePatch(["@@ -1,2 +1,2 @@", " a", "+b"].join("\n"));
    expect(gapsBetween(hunkSpans(rows), 2)).toEqual([]);
  });

  // Past a hunk that added a line, the same code sits one number higher on the
  // right than on the left, and the gap has to carry that offset to number the
  // old file's column in the side-by-side view.
  it("records how far the two files have drifted apart", () => {
    const rows = parsePatch(["@@ -1,1 +1,2 @@", " a", "+b"].join("\n"));
    const [gap] = gapsBetween(hunkSpans(rows), 10);
    expect(gap).toEqual({ index: 0, from: 3, to: 10, lineOffset: 1 });
  });

  it("treats a file with no hunks as one whole gap", () => {
    expect(gapsBetween([], 4)).toEqual([{ index: 0, from: 1, to: 4, lineOffset: 0 }]);
  });
});

describe("expandRows", () => {
  const rows = parsePatch(["@@ -5,1 +5,1 @@", "-old", "+new"].join("\n"));

  it("marks the hidden stretches on either side of a hunk", () => {
    expect(shape(expandRows(rows, FILE, new Map()))).toEqual([
      "gap:4",
      "hunk@-",
      "del@-",
      "add@5",
      "gap:5",
    ]);
  });

  it("reveals from the end of the gap that was clicked", () => {
    const expansions: Expansions = new Map([[0, { top: 0, bottom: 2 }]]);
    // Two lines revealed at the gap's bottom edge are the two directly above
    // the hunk — lines 3 and 4 — with the rest still hidden above them.
    expect(shape(expandRows(rows, FILE, expansions))).toEqual([
      "gap:2",
      "context@3",
      "context@4",
      "del@-",
      "add@5",
      "gap:5",
    ]);
  });

  it("drops the marker once both ends meet in the middle", () => {
    const expansions: Expansions = new Map([[0, { top: 2, bottom: 2 }]]);
    expect(shape(expandRows(rows, FILE, expansions))).toEqual([
      "context@1",
      "context@2",
      "context@3",
      "context@4",
      "del@-",
      "add@5",
      "gap:5",
    ]);
  });

  // The header says where the patch jumped to. Reveal the line it names as its
  // predecessor and nothing was jumped over, so the header only repeats the
  // line numbers already down the side.
  it("drops a header once the line above it is on screen", () => {
    const expansions: Expansions = new Map([[0, { top: 0, bottom: 1 }]]);
    expect(shape(expandRows(rows, FILE, expansions))).not.toContain("hunk@-");
  });

  it("keeps a header while anything above it is still hidden", () => {
    const expansions: Expansions = new Map([[0, { top: 3, bottom: 0 }]]);
    expect(shape(expandRows(rows, FILE, expansions))).toContain("hunk@-");
  });

  // The whole-file view is every gap opened at once, which leaves no hunk with
  // a hidden line above it — so none of the headers survive.
  it("leaves no headers in the whole-file view", () => {
    const two = parsePatch(["@@ -2,1 +2,1 @@", "+b", "@@ -8,1 +8,1 @@", "+h"].join("\n"));
    const all = expandAllGaps(two, FILE.length);
    expect(shape(expandRows(two, FILE, all))).not.toContain("hunk@-");
  });

  // `@@ -5,3 +4,0 @@` deletes without adding, so the hunk covers no right-side
  // line at all. Its header still has to go once line 4 — the line it sits
  // after — is showing.
  it("drops a deletion-only hunk's header too", () => {
    const deleted = parsePatch(["@@ -5,3 +4,0 @@", "-a", "-b", "-c"].join("\n"));
    const all = expandAllGaps(deleted, FILE.length);
    expect(shape(expandRows(deleted, FILE, all))).not.toContain("hunk@-");
  });

  // Both ends opening past each other must not double up on lines in the middle.
  it("never renders a line twice when the two ends overlap", () => {
    const expansions: Expansions = new Map([[0, { top: 99, bottom: 99 }]]);
    const lines = expandRows(rows, FILE, expansions)
      .filter((r) => r.kind === "row" && r.row.kind === "context")
      .map((r) => (r.kind === "row" ? r.row.rightLine : null));
    expect(lines).toEqual([1, 2, 3, 4]);
  });

  it("carries the revealed lines' text through from the file", () => {
    const expansions: Expansions = new Map([[0, { top: 1, bottom: 0 }]]);
    const first = expandRows(rows, FILE, expansions)[0];
    expect(first).toMatchObject({ kind: "row", row: { text: " l1", rightLine: 1, leftLine: 1 } });
  });

  // `@@ -4,0 +5,1 @@` inserts after old line 4, so from there on the same code
  // sits one number higher in the new file. Lines revealed below the hunk have
  // to carry that drift into the old file's column.
  it("numbers revealed lines on both sides", () => {
    const added = parsePatch(["@@ -4,0 +5,1 @@", "+new"].join("\n"));
    const expansions: Expansions = new Map([[1, { top: 1, bottom: 0 }]]);
    const revealed = expandRows(added, FILE, expansions).find(
      (r) => r.kind === "row" && r.row.kind === "context" && r.row.rightLine === 6,
    );
    expect(revealed).toMatchObject({ row: { rightLine: 6, leftLine: 5 } });
  });

  // The hunk headers fix every gap but the trailing one, so the reader can ask
  // for context before the file's content has been fetched. The gap past the
  // last hunk stays out until the file's length is known.
  it("offers the gaps the headers alone can size before content loads", () => {
    expect(shape(expandRows(rows, [], new Map()))).toEqual(["gap:4", "hunk@-", "del@-", "add@5"]);
  });

  // Otherwise the marker would shrink to nothing the instant it was clicked and
  // leave a blank stretch until the fetch came back.
  it("holds an expansion back until there are lines to show", () => {
    const expansions: Expansions = new Map([[0, { top: 0, bottom: 2 }]]);
    expect(shape(expandRows(rows, [], expansions))).toEqual(["gap:4", "hunk@-", "del@-", "add@5"]);
  });

  it("keeps every hunk's rows when there are several", () => {
    const two = parsePatch(["@@ -2,1 +2,1 @@", "+b", "@@ -8,1 +8,1 @@", "+h"].join("\n"));
    expect(shape(expandRows(two, FILE, new Map()))).toEqual([
      "gap:1",
      "hunk@-",
      "add@2",
      "gap:5",
      "hunk@-",
      "add@8",
      "gap:2",
    ]);
  });
});

describe("expansion updates", () => {
  const rows = parsePatch(["@@ -5,1 +5,1 @@", "+new"].join("\n"));
  const [gap] = gapsBetween(hunkSpans(rows), 10);

  it("opens one step at a time at the requested end", () => {
    const once = expandGap(new Map(), gap!, "bottom");
    expect(once.get(0)).toEqual({ top: 0, bottom: EXPAND_STEP });
    expect(expandGap(once, gap!, "bottom").get(0)).toEqual({ top: 0, bottom: EXPAND_STEP * 2 });
  });

  it("leaves the other end alone", () => {
    const state = expandGap(expandGap(new Map(), gap!, "top"), gap!, "bottom");
    expect(state.get(0)).toEqual({ top: EXPAND_STEP, bottom: EXPAND_STEP });
  });

  it("does not mutate the map it was given", () => {
    const before: Expansions = new Map();
    expandGap(before, gap!, "top");
    expect(before.size).toBe(0);
  });

  it("opens a gap in full", () => {
    expect(expandGapFully(new Map(), gap!).get(0)).toEqual({ top: 4, bottom: 0 });
  });

  it("opens every gap of a file at once", () => {
    const all = expandAllGaps(rows, 10);
    expect(shape(expandRows(rows, FILE, all)).filter((s) => s.startsWith("gap"))).toEqual([]);
  });
});
