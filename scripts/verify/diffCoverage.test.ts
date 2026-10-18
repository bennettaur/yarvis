import { describe, expect, it } from "bun:test";
import {
  diffCoverage,
  formatRanges,
  mergeLineHits,
  parseAddedLines,
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
  const added = new Map([
    ["src/a.ts", new Set([4, 5, 6, 23])],
    ["src/untested.ts", new Set([1])],
    ["src/a.test.ts", new Set([1])],
    ["src-tauri/src/x.rs", new Set([1])],
  ]);
  const hits = parseLcov("SF:src/a.ts\nDA:4,1\nDA:5,0\nDA:23,1\n", "", "/r");

  it("counts only executable added lines in source files", () => {
    const result = diffCoverage(added, hits, [".ts", ".tsx"]);
    // Line 6 isn't in lcov, so it's not executable and not counted.
    expect(result.changedLines).toBe(3);
    expect(result.coveredLines).toBe(2);
    expect(result.uncovered).toEqual([{ path: "src/a.ts", lines: "5" }]);
  });

  it("reports a file no test imported separately from one with gaps", () => {
    expect(diffCoverage(added, hits, [".ts", ".tsx"]).notLoaded).toEqual(["src/untested.ts"]);
  });

  it("calls a language with no coverage run unmeasured rather than untested", () => {
    expect(diffCoverage(added, hits, [".ts", ".tsx"]).unmeasured).toEqual(["src-tauri/src/x.rs"]);
  });

  it("has no ratio when nothing executable changed", () => {
    expect(diffCoverage(new Map(), hits, [".ts"]).ratio).toBeNull();
  });
});
