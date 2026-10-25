import { describe, expect, it } from "bun:test";
import {
  diffCoverage,
  formatRanges,
  type LineHits,
  mergeLineHits,
  parseAddedLines,
  parseAddedText,
  parseLcov,
} from "./diffCoverage.ts";

const DIFF = `diff --git a/src/a.ts b/src/a.ts
--- a/src/a.ts
+++ b/src/a.ts
@@ -3,0 +4,3 @@ export function a() {
+  one();
+  two();
+  three();
@@ -20 +23 @@
+  four();
diff --git a/src/gone.ts b/src/gone.ts
--- a/src/gone.ts
+++ /dev/null
@@ -1,2 +0,0 @@
`;

describe("parseAddedLines", () => {
  it("reads the new-side line numbers of each hunk", () => {
    const added = parseAddedLines(DIFF);
    expect([...(added.get("src/a.ts") ?? [])]).toEqual([4, 5, 6, 23]);
  });

  it("doesn't mistake an added line starting with '++' for a file header", () => {
    const diff =
      "diff --git a/x.ts b/x.ts\n--- a/x.ts\n+++ b/x.ts\n@@ -1,0 +2,2 @@\n+++ counter;\n+done();\n";
    expect([...(parseAddedLines(diff).get("x.ts") ?? [])]).toEqual([2, 3]);
  });

  it("skips deleted files", () => {
    expect(parseAddedLines(DIFF).has("src/gone.ts")).toBe(false);
  });
});

describe("parseLcov", () => {
  it("prefixes paths with the suite directory bun ran from", () => {
    const hits = parseLcov("SF:src/x.ts\nDA:1,2\nDA:2,0\nend_of_record\n", "sidecar", "/repo");
    expect(hits.get("sidecar/src/x.ts")?.get(1)).toBe(2);
  });

  it("makes absolute paths relative to the repo root", () => {
    const hits = parseLcov("SF:/repo/src-tauri/src/a.rs\nDA:5,1\n", "", "/repo");
    expect(hits.has("src-tauri/src/a.rs")).toBe(true);
  });

  it("drops sources outside the repo", () => {
    const hits = parseLcov("SF:/home/me/.cargo/registry/x.rs\nDA:5,1\n", "", "/repo");
    expect(hits.size).toBe(0);
  });
});

describe("mergeLineHits", () => {
  it("keeps a line covered if any suite covered it", () => {
    const a = parseLcov("SF:a.ts\nDA:1,0\n", "", "/r");
    const b = parseLcov("SF:a.ts\nDA:1,3\n", "", "/r");
    expect(mergeLineHits(a, b).get("a.ts")?.get(1)).toBe(3);
  });
});

describe("formatRanges", () => {
  it("collapses runs of lines", () => {
    expect(formatRanges([9, 3, 4, 5, 11])).toBe("3-5, 9, 11");
  });
});

describe("diffCoverage", () => {
  const tsOnly = (path: string) => (path.endsWith(".rs") ? "not-run" : "measured");
  const added = new Map([
    ["src/a.ts", new Set([4, 5, 6, 23])],
    ["src/untested.ts", new Set([1])],
    ["src/a.test.ts", new Set([1])],
    ["src-tauri/src/x.rs", new Set([1])],
  ]);
  const hits = parseLcov("SF:src/a.ts\nDA:4,1\nDA:5,0\nDA:23,1\n", "", "/r");

  it("counts only executable added lines in source files", () => {
    const result = diffCoverage(added, hits, tsOnly);
    // Line 6 isn't in lcov, so it's not executable and not counted.
    expect(result.changedLines).toBe(3);
    expect(result.coveredLines).toBe(2);
    expect(result.uncovered).toEqual([{ path: "src/a.ts", lines: "5" }]);
  });

  it("reports a file no test imported separately from one with gaps", () => {
    expect(diffCoverage(added, hits, tsOnly).notLoaded).toEqual(["src/untested.ts"]);
  });

  it("calls a language with no coverage run unmeasured rather than untested", () => {
    expect(diffCoverage(added, hits, tsOnly).unmeasured).toEqual(["src-tauri/src/x.rs"]);
  });

  it("has no ratio when nothing executable changed", () => {
    expect(diffCoverage(new Map(), hits, () => "measured").ratio).toBeNull();
  });

  it("sorts files of one language by what their own suite's run produced", () => {
    const added = parseAddedLines(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -0,0 +1 @@",
        "+x",
        "diff --git a/sidecar/src/b.ts b/sidecar/src/b.ts",
        "--- a/sidecar/src/b.ts",
        "+++ b/sidecar/src/b.ts",
        "@@ -0,0 +1 @@",
        "+y",
        "diff --git a/sidecar/src/c.ts b/sidecar/src/c.ts",
        "--- a/sidecar/src/c.ts",
        "+++ b/sidecar/src/c.ts",
        "@@ -0,0 +1 @@",
        "+z",
      ].join("\n"),
    );
    const hits: LineHits = new Map([["src/a.ts", new Map([[1, 1]])]]);
    const result = diffCoverage(added, hits, (path) =>
      path === "src/a.ts" ? "measured" : path.endsWith("b.ts") ? "no-tests" : "not-run",
    );
    expect(result).toMatchObject({
      ratio: 1,
      notLoaded: [],
      noTestsRan: ["sidecar/src/b.ts"],
      unmeasured: ["sidecar/src/c.ts"],
    });
  });
});

describe("parseAddedText", () => {
  it("joins each file's added lines, and only those", () => {
    const text = parseAddedText(DIFF);
    expect(text.get("src/a.ts")).toBe("  one();\n  two();\n  three();\n  four();");
    expect(text.has("src/gone.ts")).toBe(false);
  });
});
