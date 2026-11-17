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
      source("scripts/old.sh", { status: "deleted" }),
    ];
    const collector = tripwireCollector(sources);
    const blob = `+x = '${"0123456789abcdef".repeat(20)}'`;
    collector.onPatch(sources[3] as PatchSource, ["@@ -1 +1 @@", blob].join("\n"));
    collector.onPatch(sources[4] as PatchSource, ["@@ -1 +1 @@", blob].join("\n"));
    const { tripwires, omitted } = collector.result();
    expect(tripwires.map((t) => [t.kind, t.path])).toEqual([
      ["build", ".github/workflows/ci.yml"],
      ["binary", "fixtures/data.bin"],
      ["test-tampering", "src/__snapshots__/view.test.ts.snap"],
      ["opaque-blob", "src/a.ts"],
    ]);
    expect(omitted).toBe(0);
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
