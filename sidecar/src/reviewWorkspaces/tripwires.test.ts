import { describe, expect, it } from "bun:test";
import type { PatchSource } from "./patchFiles.ts";
import { MAX_TRIPWIRES, scanPatch, sensitivePath, tripwireCollector } from "./tripwires.ts";

const source = (path: string, over: Partial<PatchSource> = {}): PatchSource => ({
  path,
  status: "modified",
  additions: 1,
  deletions: 0,
  binary: false,
  read: async () => ({ patch: "", complete: true }),
  ...over,
});

describe("sensitivePath", () => {
  it("flags files that decide what runs in CI, at build or install, or for an agent", () => {
    for (const path of [
      ".github/workflows/ci.yml",
      "Makefile",
      "m4/build-to-host.m4",
      "docker/Dockerfile.dev",
      "packages/app/package.json",
      ".claude/settings.json",
      "CLAUDE.md",
      ".github/CODEOWNERS",
      ".husky/pre-commit",
    ]) {
      expect(sensitivePath(path), path).not.toBeNull();
    }
  });

  it("leaves ordinary source and docs alone", () => {
    for (const path of ["src/app.ts", "docs/workflows.md", "src/package.ts", "README.md"]) {
      expect(sensitivePath(path), path).toBeNull();
    }
  });
});

describe("scanPatch", () => {
  it("finds hidden characters and long encoded strings on added lines, at their head line", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789".repeat(5);
    const found = scanPatch(
      "src/auth.ts",
      [
        "@@ -10,2 +10,4 @@",
        " const ok = check(user);",
        `+if (role === "admin‮") return true;`,
        `+const payload = "${blob}";`,
        " export {};",
        `-const old = "​";`,
      ].join("\n"),
    );
    expect(found).toEqual([
      expect.objectContaining({ kind: "hidden-text", line: 11 }),
      expect.objectContaining({ kind: "opaque-blob", line: 12 }),
    ]);
  });

  it("in a test file, finds skipped tests and assertions taken out", () => {
    const found = scanPatch(
      "src/auth.test.ts",
      [
        "@@ -1,4 +1,3 @@",
        '-it("rejects a bad token", () => {',
        '+it.skip("rejects a bad token", () => {',
        "-  expect(verify(bad)).toBe(false);",
        "-  expect(log).toHaveLength(1);",
        "+  expect(verify(bad)).toBeDefined();",
        " });",
      ].join("\n"),
    );
    expect(found).toEqual([
      expect.objectContaining({ kind: "test-tampering", line: 1, note: "test skipped or focused" }),
      expect.objectContaining({ kind: "test-tampering", note: "2 assertions removed, 1 added" }),
    ]);
  });

  it("finds an encoded string after filler on the same line", () => {
    const blob = "QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo0123456789".repeat(5);
    const line = `+/* ${"-".repeat(240)} */ const p = "${blob}";`;
    expect(scanPatch("src/p.ts", ["@@ -1 +1 @@", line].join("\n"))).toEqual([
      expect.objectContaining({ kind: "opaque-blob", line: 1 }),
    ]);
  });

  it("finds tag characters and invisible identifiers", () => {
    const tagged = `+// ok${String.fromCodePoint(0xe0041, 0xe0042)}`;
    const filler = "+const { a, \u3164 } = req.query;";
    const found = scanPatch("src/q.ts", ["@@ -1,0 +1,2 @@", tagged, filler].join("\n"));
    expect(found.map((t) => [t.kind, t.line])).toEqual([
      ["hidden-text", 1],
      ["hidden-text", 2],
    ]);
  });

  it("checks a lockfile or minified file for hidden text only", () => {
    const patch = ["@@ -1 +1 @@", `+"x": "${"0123456789abcdef".repeat(20)}\u202E"`].join("\n");
    expect(scanPatch("yarn.lock", patch, true).map((t) => t.kind)).toEqual(["hidden-text"]);
  });

  it("doesn't take a long run of one character for encoded data", () => {
    expect(scanPatch("src/rule.ts", ["@@ -1 +1 @@", `+// ${"=".repeat(240)}`].join("\n"))).toEqual(
      [],
    );
  });

  it("doesn't count test markers outside test files", () => {
    expect(scanPatch("src/list.ts", ["@@ -1 +1 @@", "+items.only(1);"].join("\n"))).toEqual([]);
  });
});

describe("tripwireCollector", () => {
  it("flags sensitive paths, binaries and snapshots, and scans patches that aren't bulk", () => {
    const sources = [
      source(".github/workflows/ci.yml"),
      source("fixtures/data.bin", { binary: true }),
      source("src/__snapshots__/view.test.ts.snap"),
      source("bun.lock", { skim: "lockfile" }),
      source("src/a.ts"),
      source(".github/workflows/scan.yml", { status: "deleted" }),
      source("src/auth.test.ts", { status: "deleted" }),
      source("docs/old.md", { status: "deleted" }),
    ];
    const collector = tripwireCollector(sources);
    const blob = `+x = '${"0123456789abcdef".repeat(20)}'`;
    collector.onPatch(sources[3] as PatchSource, ["@@ -1 +1 @@", blob].join("\n"));
    collector.onPatch(sources[4] as PatchSource, ["@@ -1 +1 @@", blob].join("\n"));
    const { tripwires, omitted } = collector.result();
    // The most telling kinds first; within a kind, the diff's order.
    expect(tripwires.map((t) => [t.kind, t.path])).toEqual([
      ["opaque-blob", "src/a.ts"],
      ["test-tampering", "src/__snapshots__/view.test.ts.snap"],
      ["test-tampering", "src/auth.test.ts"],
      ["build", ".github/workflows/ci.yml"],
      ["build", "bun.lock"],
      ["build", ".github/workflows/scan.yml"],
      ["binary", "fixtures/data.bin"],
    ]);
    expect(tripwires.find((t) => t.path.endsWith("scan.yml"))?.note).toStartWith(
      "removed CI configuration",
    );
    expect(omitted).toBe(0);
  });

  it("flags a test or workflow moved somewhere it no longer counts", () => {
    const { tripwires } = tripwireCollector([
      source("src/auth.ts.bak", { oldPath: "src/auth.test.ts", status: "renamed" }),
      source("ci/build.yml", { oldPath: ".github/workflows/build.yml", status: "renamed" }),
    ]).result();
    expect(tripwires.map((t) => t.note)).toEqual([
      "moved out of the tests from src/auth.test.ts",
      expect.stringContaining("moved from .github/workflows/build.yml"),
    ]);
  });

  it("keeps hidden text over a flood of binaries when it has to cut the list", () => {
    const sources = [
      ...Array.from({ length: MAX_TRIPWIRES + 5 }, (_, i) =>
        source(`icons/${i}.png`, { binary: true }),
      ),
      source("src/x.ts"),
    ];
    const collector = tripwireCollector(sources);
    collector.onPatch(sources.at(-1) as PatchSource, "@@ -1 +1 @@\n+a\u202Eb");
    const { tripwires, omitted } = collector.result();
    expect(tripwires[0]).toMatchObject({ kind: "hidden-text", path: "src/x.ts" });
    expect(omitted).toBe(6);
  });

  it("keeps the first few and counts the rest", () => {
    const sources = Array.from({ length: MAX_TRIPWIRES + 3 }, (_, i) =>
      source(`.github/workflows/w${i}.yml`),
    );
    const { tripwires, omitted } = tripwireCollector(sources).result();
    expect(tripwires).toHaveLength(MAX_TRIPWIRES);
    expect(omitted).toBe(3);
  });
});
