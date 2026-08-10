import { describe, expect, it } from "bun:test";
import { pairRows, parsePatch } from "./diff";

describe("parsePatch", () => {
  it("assigns right-side line numbers from the hunk header", () => {
    const patch = ["@@ -1,2 +1,3 @@", " a", "+b", " c"].join("\n");
    const rows = parsePatch(patch);
    expect(rows.map((r) => [r.kind, r.rightLine])).toEqual([
      ["hunk", null],
      ["context", 1],
      ["add", 2],
      ["context", 3],
    ]);
  });

  it("does not advance the right line on deletions", () => {
    const patch = ["@@ -1,3 +1,2 @@", " a", "-b", " c"].join("\n");
    const rows = parsePatch(patch);
    expect(rows.map((r) => [r.kind, r.rightLine])).toEqual([
      ["hunk", null],
      ["context", 1],
      ["del", null],
      ["context", 2],
    ]);
  });

  it("resets the right line across multiple hunks", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+x", "@@ -10,1 +20,1 @@", "+y"].join("\n");
    const rows = parsePatch(patch);
    expect(rows.filter((r) => r.kind === "add").map((r) => r.rightLine)).toEqual([1, 20]);
  });

  it("treats no-newline markers as metadata that does not advance lines", () => {
    const patch = ["@@ -1,1 +1,1 @@", "+x", "\\ No newline at end of file"].join("\n");
    const rows = parsePatch(patch);
    expect(rows[2]).toMatchObject({ kind: "meta", rightLine: null });
  });

  it("skips the git file-header block so it neither renders nor skews line numbers", () => {
    const patch = [
      "diff --git a/foo.ts b/foo.ts",
      "index 0729d53..093d8c2 100644",
      "--- a/foo.ts",
      "+++ b/foo.ts",
      "@@ -1,2 +1,3 @@",
      " a",
      "+b",
      " c",
    ].join("\n");
    const rows = parsePatch(patch);
    expect(rows.map((r) => [r.kind, r.rightLine])).toEqual([
      ["hunk", null],
      ["context", 1],
      ["add", 2],
      ["context", 3],
    ]);
  });

  it("tracks left-side line numbers independently of the right", () => {
    // The sides drift apart the moment a hunk adds or removes: after the added
    // "b", every later line sits one number higher on the right than the left.
    const patch = ["@@ -1,3 +1,4 @@", " a", "+b", " c", "-d", " e"].join("\n");
    const rows = parsePatch(patch);
    expect(rows.map((r) => [r.kind, r.leftLine, r.rightLine])).toEqual([
      ["hunk", null, null],
      ["context", 1, 1],
      ["add", null, 2],
      ["context", 2, 3],
      ["del", 3, null],
      ["context", 4, 4],
    ]);
  });

  it("resets the left line across multiple hunks", () => {
    const patch = ["@@ -1,1 +1,1 @@", "-x", "@@ -10,1 +20,1 @@", "-y"].join("\n");
    const rows = parsePatch(patch);
    expect(rows.filter((r) => r.kind === "del").map((r) => r.leftLine)).toEqual([1, 10]);
  });
});

describe("pairRows", () => {
  it("puts a rewritten line across from the line it replaced", () => {
    const rows = parsePatch(["@@ -1,2 +1,2 @@", " a", "-old", "+new"].join("\n"));
    expect(pairRows(rows)).toEqual([
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      {
        kind: "pair",
        left: { kind: "context", text: "a", line: 1 },
        right: { kind: "context", text: "a", line: 1 },
      },
      {
        kind: "pair",
        left: { kind: "del", text: "old", line: 2 },
        right: { kind: "add", text: "new", line: 2 },
      },
    ]);
  });

  it("pads the shorter side of an uneven run with a blank", () => {
    const rows = parsePatch(["@@ -1,2 +1,3 @@", "-a", "-b", "+c", "+d", "+e"].join("\n"));
    const pairs = pairRows(rows).filter((r) => r.kind === "pair");
    expect(pairs).toEqual([
      {
        kind: "pair",
        left: { kind: "del", text: "a", line: 1 },
        right: { kind: "add", text: "c", line: 1 },
      },
      {
        kind: "pair",
        left: { kind: "del", text: "b", line: 2 },
        right: { kind: "add", text: "d", line: 2 },
      },
      { kind: "pair", left: null, right: { kind: "add", text: "e", line: 3 } },
    ]);
  });

  // Context between two change runs has to close the first one out; otherwise a
  // deletion above the context would pair with an addition below it.
  it("does not pair across intervening context", () => {
    const rows = parsePatch(["@@ -1,3 +1,3 @@", "-a", " b", "+c"].join("\n"));
    const pairs = pairRows(rows).filter((r) => r.kind === "pair");
    expect(pairs.map((p) => [p.left?.text ?? null, p.right?.text ?? null])).toEqual([
      ["a", null],
      ["b", "b"],
      [null, "c"],
    ]);
  });

  it("spans hunk headers and no-newline markers across both columns", () => {
    const rows = parsePatch(["@@ -1,1 +1,1 @@", "+x", "\\ No newline at end of file"].join("\n"));
    expect(pairRows(rows).map((r) => r.kind)).toEqual(["hunk", "pair", "meta"]);
  });

  it("strips the marker column so both sides line up on the same indentation", () => {
    const rows = parsePatch(["@@ -1,1 +1,1 @@", "-  old()", "+  new()"].join("\n"));
    const [, pair] = pairRows(rows);
    expect(pair).toMatchObject({
      left: { text: "  old()" },
      right: { text: "  new()" },
    });
  });
});
