import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLcov } from "./diffCoverage.ts";
import {
  mergeMutation,
  mutationTargets,
  readStrykerReport,
  relatedTests,
  testCommand,
} from "./mutation.ts";

describe("mutationTargets", () => {
  const added = new Map([
    ["src/lib/a.ts", new Set([3, 4, 5, 9, 20])],
    ["src/lib/a.test.ts", new Set([1])],
    ["src/lib/types.d.ts", new Set([1])],
    ["src/components/B.tsx", new Set([2])],
    ["sidecar/src/b.ts", new Set([1, 2])],
  ]);
  const hits = parseLcov(
    [
      "SF:src/lib/a.ts",
      "DA:3,1",
      "DA:4,2",
      "DA:5,1",
      "DA:9,1",
      "DA:20,0",
      "SF:src/lib/a.test.ts",
      "DA:1,1",
      "SF:src/lib/types.d.ts",
      "DA:1,1",
      "SF:src/components/B.tsx",
      "DA:2,1",
      "SF:sidecar/src/b.ts",
      "DA:1,1",
      "DA:2,1",
    ].join("\n"),
    "",
    "/r",
  );

  it("turns covered changed lines into ranges, leaving out tests, declarations and unrun lines", () => {
    expect(mutationTargets(added, hits, "frontend")).toEqual({
      targets: ["src/lib/a.ts:3-5", "src/lib/a.ts:9-9", "src/components/B.tsx:2-2"],
      skipped: 0,
    });
  });

  it("gives each suite only its own files", () => {
    expect(mutationTargets(added, hits, "sidecar").targets).toEqual(["sidecar/src/b.ts:1-2"]);
  });

  it("caps the ranges and says how many it left out", () => {
    const lines = new Set(Array.from({ length: 50 }, (_, i) => i * 2 + 1));
    const many = new Map([["src/big.ts", lines]]);
    const manyHits = parseLcov(
      ["SF:src/big.ts", ...[...lines].map((line) => `DA:${line},1`)].join("\n"),
      "",
      "/r",
    );
    const { targets, skipped } = mutationTargets(many, manyHits, "frontend");
    expect(targets).toHaveLength(40);
    expect(skipped).toBe(10);
  });
});

describe("relatedTests", () => {
  function withRepo(files: string[], check: (root: string) => void) {
    const root = mkdtempSync(join(tmpdir(), "mutation-test-"));
    try {
      for (const file of files) {
        mkdirSync(join(root, file, ".."), { recursive: true });
        writeFileSync(join(root, file), "");
      }
      check(root);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  it("runs the suite's changed tests plus each mutated file's sibling test", () => {
    withRepo(["src/lib/a.test.ts"], (root) => {
      expect(
        relatedTests(
          root,
          "frontend",
          ["src/lib/a.ts:3-5", "src/lib/b.ts:1-1"],
          ["src/other.test.ts", "sidecar/src/x.test.ts"],
        ),
      ).toEqual(["src/lib/a.test.ts", "src/other.test.ts"]);
    });
  });

  it("finds sidecar siblings and keeps the paths repo-relative", () => {
    withRepo(["sidecar/src/b.test.ts"], (root) => {
      expect(relatedTests(root, "sidecar", ["sidecar/src/b.ts:1-2"], ["src/a.test.ts"])).toEqual([
        "sidecar/src/b.test.ts",
      ]);
    });
  });
});

describe("testCommand", () => {
  it("quotes every path, so a file name can't add shell syntax", () => {
    expect(testCommand("/bin/bun", "frontend", ["src/a;rm -rf x.test.ts"])).toBe(
      "'/bin/bun' test './src/a;rm -rf x.test.ts'",
    );
  });

  it("runs the sidecar suite from sidecar/, with paths relative to it", () => {
    expect(testCommand("/bin/bun", "sidecar", ["sidecar/src/b.test.ts"])).toBe(
      "cd sidecar && '/bin/bun' test './src/b.test.ts'",
    );
  });
});

describe("readStrykerReport", () => {
  const mutant = (status: string, line: number, replacement?: string) => ({
    status,
    mutatorName: "EqualityOperator",
    replacement,
    location: { start: { line } },
  });

  it("scores caught mutants over those that ran, and lists the rest", () => {
    const result = readStrykerReport({
      files: {
        "sidecar/src/a.ts": {
          mutants: [
            mutant("Killed", 1),
            mutant("Timeout", 2),
            mutant("Survived", 3, "n <= lo"),
            mutant("CompileError", 4),
          ],
        },
      },
    });
    expect(result).toEqual({
      score: 2 / 3,
      killed: 2,
      survived: ["sidecar/src/a.ts:3 EqualityOperator → n <= lo"],
    });
  });

  it("has no score when no mutant ran", () => {
    expect(readStrykerReport({ files: {} }).score).toBeNull();
  });
});

describe("mergeMutation", () => {
  it("scores across suites by mutant, not by averaging", () => {
    const merged = mergeMutation([
      { score: 1, killed: 9, survived: [], skippedRanges: 1 },
      { score: 0, killed: 0, survived: ["x:1 y"], skippedRanges: 2 },
    ]);
    expect(merged.score).toBe(0.9);
    expect(merged.skippedRanges).toBe(3);
  });
});
