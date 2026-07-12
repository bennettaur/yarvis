import { describe, expect, it } from "bun:test";
import { parsePatch } from "./diff";

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
});
