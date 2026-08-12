import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import { parsePatch } from "../../lib/pr/diff";
import { expandAllGaps } from "../../lib/pr/expand";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { fakeExpansion } from "../../test/expansion";
import { renderToHtml } from "../../test/render";
import SplitDiffBody, { pairAroundGaps } from "./SplitDiffBody";

const prRef: PrRef = { provider: "github", owner: "octo", repo: "repo", number: 1 };

const file: PrFile = {
  filename: "foo.ts",
  status: "modified",
  additions: 0,
  deletions: 0,
  patch: "",
};

const render = (
  patch: string,
  threads: ReviewThread[] = [],
  highlight?: { start: number; end: number } | null,
) =>
  renderToHtml(
    createElement(SplitDiffBody, {
      prRef,
      file: { ...file, patch },
      threads,
      expansion: fakeExpansion(patch),
      highlight,
    }),
  );

describe("SplitDiffBody", () => {
  // The whole point of the split view: the old file's numbering on the left and
  // the new file's on the right, which diverge as soon as a hunk adds a line.
  it("renders both files' line numbers", async () => {
    const html = await render(["@@ -10,2 +20,2 @@", " a", "-old", "+new"].join("\n"));
    expect(html).toContain(">10<");
    expect(html).toContain(">20<");
    expect(html).toContain(">11<");
    expect(html).toContain(">21<");
  });

  it("strips the marker column from the code cells", async () => {
    const html = await render(["@@ -1,1 +1,1 @@", "-old()", "+new()"].join("\n"));
    expect(html).toContain(">old()<");
    expect(html).toContain(">new()<");
    expect(html).not.toContain(">-old()<");
    expect(html).not.toContain(">+new()<");
  });

  // Hunk headers belong to neither file, so they run the full width instead of
  // being pushed into one of the two columns.
  it("spans hunk headers across both columns", async () => {
    const html = await render(["@@ -1,1 +1,1 @@", "+a"].join("\n"));
    expect(html).toContain("col-span-4");
    expect(html).toContain("@@ -1,1 +1,1 @@");
  });

  // Three deletions across from one addition leaves two right-hand cells empty;
  // they get the filler background so the gap reads as "nothing here" rather
  // than as an unchanged blank line.
  it("fills the blank half of an uneven change", async () => {
    const html = await render(["@@ -1,3 +1,1 @@", "-a", "-b", "-c", "+d"].join("\n"));
    expect(html).toContain("bg-zinc-900/40");
  });

  const CONTAINER_MARKER = "font-sans";

  it("renders no comment container on lines without comments", async () => {
    const html = await render(["@@ -1,2 +1,2 @@", "-a", "+b"].join("\n"));
    expect(html).not.toContain(CONTAINER_MARKER);
  });

  it("anchors a thread to its right-side line", async () => {
    const thread: ReviewThread = {
      path: file.filename,
      line: 2,
      isResolved: false,
      comments: [{ author: "octocat", body: "needs a guard", createdAt: "" }],
    };
    const html = await render(["@@ -1,2 +1,2 @@", " a", "+b"].join("\n"), [thread]);
    expect(html).toContain(CONTAINER_MARKER);
    expect(html).toContain("needs a guard");
  });

  // A gap belongs to neither file, so like a hunk header it runs the full width
  // rather than being pushed into one of the two columns.
  it("spans a gap marker across both columns", async () => {
    const html = await render(["@@ -40,1 +40,1 @@", "+x"].join("\n"));
    expect(html).toContain("⋯ 39 lines");
    expect(html).toContain("col-span-4");
  });

  // Pairing runs per stretch of rows, so a deletion above a gap can never be
  // matched up with an addition below it — they are not related changes. If
  // they had been paired there would be one row carrying both, and neither
  // line number would sit alone.
  it("does not pair changes across a gap", async () => {
    const patch = ["@@ -1,1 +1,1 @@", "-a", "@@ -40,1 +40,1 @@", "+b"].join("\n");
    const rows = pairAroundGaps(fakeExpansion(patch).rows).filter((r) => r.kind === "pair");
    expect(rows).toEqual([
      { kind: "pair", left: { kind: "del", text: "a", line: 1 }, right: null },
      { kind: "pair", left: null, right: { kind: "add", text: "b", line: 40 } },
    ]);
  });

  // Deleted lines only exist on the left, and neither provider accepts a
  // comment anchored there, so no composer is offered against them.
  it("offers the composer only where there is a right-side line", async () => {
    const html = await render(["@@ -1,2 +1,1 @@", "-a", "-b"].join("\n"));
    expect(html).not.toContain("Comment on this line");
  });
});

describe("SplitDiffBody guided-review highlighting", () => {
  const patch = ["@@ -1,4 +1,4 @@", " a", "+b", "+c", " d"].join("\n");

  // One marker per row, on its leftmost cell: grid cells are siblings with no
  // row element between them, so there is nothing spanning the row to mark.
  it("marks one edge per row in the range", async () => {
    const html = await render(patch, [], { start: 2, end: 3 });
    expect(html.split("inset 3px").length - 1).toBe(2);
  });

  it("anchors the first line of the range for scrolling", async () => {
    const html = await render(patch, [], { start: 2, end: 3 });
    expect(html.split("data-pr-focus").length - 1).toBe(1);
  });

  it("marks nothing without a range", async () => {
    expect(await render(patch)).not.toContain("inset 3px");
  });
});

describe("SplitDiffBody whole-file view", () => {
  const patch = ["@@ -3,1 +3,1 @@", "-old", "+new"].join("\n");
  const fileLines = ["l1", "l2", "l3", "l4", "l5"];

  // Issue #191: with the file shown in full, a header marks a jump the reader
  // can see did not happen.
  it("draws no hunk header once the whole file is showing", async () => {
    const html = await renderToHtml(
      createElement(SplitDiffBody, {
        prRef,
        file: { ...file, patch },
        threads: [],
        expansion: fakeExpansion(patch, {
          fileLines,
          expansions: expandAllGaps(parsePatch(patch), fileLines.length),
          wholeFile: true,
        }),
      }),
    );
    expect(html).not.toContain("@@ -3,1 +3,1 @@");
    expect(html).toContain(">old<");
    expect(html).toContain(">new<");
  });
});
