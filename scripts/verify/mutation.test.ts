import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseLcov } from "./diffCoverage.ts";
import { mergeMutation, mutationTargets, readStrykerReport, relatedTests } from "./mutation.ts";

describe("mutationTargets", () => {
  const added = new Map([
    ["src/lib/a.ts", new Set([3, 4, 5, 9, 20])],
    ["src/lib/a.test.ts", new Set([1])],
    ["sidecar/src/b.ts", new Set([1, 2])],
  ]);
  const hits = parseLcov(
    "SF:src/lib/a.ts\nDA:3,1\nDA:4,2\nDA:5,1\nDA:9,1\nDA:20,0\nSF:sidecar/src/b.ts\nDA:1,1\nDA:2,1\n",
    "",
    "/r",
  );

  it("turns the covered changed lines into Stryker ranges, skipping lines no test ran", () => {
    expect(mutationTargets(added, hits, "")).toEqual(["src/lib/a.ts:3-5", "src/lib/a.ts:9-9"]);
  });

  it("gives each suite its own files, relative to where it runs", () => {
    expect(mutationTargets(added, hits, "sidecar")).toEqual(["src/b.ts:1-2"]);
  });
});

describe("relatedTests", () => {
  it("runs the PR's changed tests plus each mutated file's sibling test", () => {
    const root = mkdtempSync(join(tmpdir(), "mutation-test-"));
    try {
      mkdirSync(join(root, "src/lib"), { recursive: true });
      writeFileSync(join(root, "src/lib/a.test.ts"), "");
      expect(
        relatedTests(
          root,
          "",
          ["src/lib/a.ts:3-5", "src/lib/b.ts:1-1"],
          ["src/other.test.ts", "sidecar/src/x.test.ts"],
        ),
      ).toEqual(["src/lib/a.test.ts", "src/other.test.ts"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    const result = readStrykerReport(
      {
        files: {
          "src/a.ts": {
            mutants: [
              mutant("Killed", 1),
              mutant("Timeout", 2),
              mutant("Survived", 3, "n <= lo"),
              mutant("CompileError", 4),
            ],
          },
        },
      },
      "sidecar",
    );
    expect(result).toEqual({
      score: 2 / 3,
      killed: 2,
      survived: ["sidecar/src/a.ts:3 EqualityOperator → n <= lo"],
    });
  });

  it("has no score when no mutant ran", () => {
    expect(readStrykerReport({ files: {} }, "").score).toBeNull();
  });
});

describe("mergeMutation", () => {
  it("scores across suites by mutant, not by averaging", () => {
    const merged = mergeMutation([
      { score: 1, killed: 9, survived: [] },
      { score: 0, killed: 0, survived: ["x:1 y"] },
    ]);
    expect(merged.score).toBe(0.9);
  });
});
