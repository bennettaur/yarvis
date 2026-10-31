import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { RunActivity } from "../agentRuns/service.ts";
import { StreamJsonParser } from "../agentRuns/streamJson.ts";
import { coverageOf, safeCoverage } from "./coverage.ts";
import type { PatchIndexEntry } from "./patchFiles.ts";

// Real folders, so real paths resolve: the context folder sits in the temp
// folder, which macOS reaches through /var -> /private/var.
const cwd = mkdtempSync(join(tmpdir(), "yarvis-coverage-checkout-"));
const contextDir = mkdtempSync(join(tmpdir(), "yarvis-coverage-context-"));
afterAll(() => {
  rmSync(cwd, { recursive: true, force: true });
  rmSync(contextDir, { recursive: true, force: true });
});

function touch(root: string, path: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), "x\n");
}

function entry(path: string, overrides: Partial<PatchIndexEntry> = {}): PatchIndexEntry {
  const e: PatchIndexEntry = {
    path,
    status: "modified",
    additions: 3,
    deletions: 1,
    binary: false,
    patchFile: `patches/${path}.diff`,
    lines: 1200,
    bytes: 40_000,
    truncated: false,
    noPatch: null,
    hunks: [{ start: 10, count: 5 }],
    skim: null,
    markedByPr: false,
    longLines: 0,
    ...overrides,
  };
  if (e.patchFile) touch(contextDir, e.patchFile);
  if (e.status !== "deleted") touch(cwd, path);
  return e;
}

let toolId = 0;

/** A stream-json `assistant` line making one tool call, as `parent`'s or the main agent's. */
function call(name: string, input: Record<string, unknown>, parent: string | null = null) {
  const id = `toolu_${++toolId}`;
  return {
    id,
    line: JSON.stringify({
      type: "assistant",
      parent_tool_use_id: parent,
      message: { id: `msg_${id}`, content: [{ type: "tool_use", id, name, input }] },
    }),
  };
}

const delegate = (type: string) =>
  call("Agent", { subagent_type: `yarvis-review:${type}`, description: type });

const readCall = (input: Record<string, unknown>, parent: string | null = null) =>
  call("Read", input, parent);

const failed = (id: string) =>
  JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: true }] },
  });

/** Feeds the lines through the run's own parser and returns what a finishing step gets. */
function activityFrom(lines: string[]): RunActivity {
  const parser = new StreamJsonParser(cwd);
  for (const line of lines) parser.parseLine(line);
  return { reads: parser.fileReads, subagents: parser.subagents };
}

const where = { cwd, contextDir };

describe("coverage from a run's reads", () => {
  it("counts a patch read whole or in pages, and names why the rest weren't", () => {
    const index = [
      entry("src/a.ts"),
      entry("src/b.ts"),
      entry("src/c.ts"),
      entry("src/d.ts"),
      entry("src/new.ts", { status: "added", deletions: 0, hunks: [{ start: 1, count: 40 }] }),
      entry("src/escape.ts", { status: "added", deletions: 0, hunks: [{ start: 1, count: 4 }] }),
    ];
    const a1 = readCall({ file_path: `${contextDir}/patches/src/a.ts.diff`, limit: 800 });
    // The same folder by its other spelling, and a page that overlaps.
    const a2 = readCall({
      file_path: `/private${contextDir}/patches/src/a.ts.diff`,
      offset: 700,
      limit: 800,
    });
    // Whole in one go, but the tool refused it (too many tokens).
    const b = readCall({ file_path: `${contextDir}/patches/src/b.ts.diff` });
    const c = readCall({ file_path: `${contextDir}/patches/src/c.ts.diff`, limit: 600 });
    // An offset that isn't a number: what it showed can't be known.
    const d = readCall({ file_path: `${contextDir}/patches/src/d.ts.diff`, offset: "1" });
    // An added file read in the checkout, by a relative path, covering its hunk.
    const fresh = readCall({ file_path: "src/new.ts" });
    // A path that climbs out and back in counts for nothing.
    const climb = readCall({ file_path: `${cwd}/src/../src/escape.ts` });
    const activity = activityFrom([
      a1.line,
      a2.line,
      b.line,
      failed(b.id),
      c.line,
      d.line,
      fresh.line,
      climb.line,
    ]);
    const { coverage, touched } = coverageOf(index, activity, where);
    expect(coverage).toEqual({
      examined: 2,
      total: 6,
      skimmed: [],
      notExamined: [
        { path: "src/b.ts", reason: "the read failed; it wasn't re-read in pages" },
        { path: "src/c.ts", reason: "only 600 of its patch's 1200 lines were read" },
        { path: "src/d.ts", reason: "its patch wasn't opened" },
        { path: "src/escape.ts", reason: "its patch wasn't opened" },
      ],
      laneGaps: [],
    });
    expect([...touched].sort()).toEqual(["src/a.ts", "src/c.ts", "src/new.ts"]);
  });

  it("doesn't count the head file for a change that removed lines", () => {
    const read = readCall({ file_path: `${cwd}/src/removes.ts` });
    expect(
      coverageOf([entry("src/removes.ts")], activityFrom([read.line]), where).coverage.notExamined,
    ).toEqual([{ path: "src/removes.ts", reason: "its patch wasn't opened" }]);
  });

  it("skims bulk on its first page, and never counts long lines or a cut-off diff as read", () => {
    const index = [
      entry("package-lock.json", { skim: "lockfile", lines: 9000 }),
      entry("generated/api.ts", { skim: "generated", lines: 9000 }),
      entry("src/min.ts", { lines: 100, longLines: 3 }),
      entry("src/huge.ts", { truncated: true, lines: 500 }),
      // A pure addition, cut off: its head file shows it all.
      entry("src/added.ts", {
        status: "added",
        deletions: 0,
        truncated: true,
        lines: 500,
        hunks: [{ start: 1, count: 30_000 }],
      }),
      entry("img.png", { binary: true, status: "deleted", patchFile: null, noPatch: "binary" }),
      entry("logo.png", { binary: true, patchFile: null, noPatch: "binary", hunks: [] }),
    ];
    const activity = activityFrom([
      readCall({ file_path: `${contextDir}/patches/package-lock.json.diff`, limit: 200 }).line,
      readCall({ file_path: `${contextDir}/patches/src/min.ts.diff` }).line,
      readCall({ file_path: `${contextDir}/patches/src/huge.ts.diff` }).line,
      readCall({ file_path: `${cwd}/src/added.ts`, limit: 30_000 }).line,
    ]);
    const { coverage } = coverageOf(index, activity, where);
    expect(coverage.skimmed).toEqual([{ path: "package-lock.json", kind: "lockfile" }]);
    expect(coverage.examined).toBe(2);
    expect(coverage.notExamined).toEqual([
      { path: "generated/api.ts", reason: "generated, and not even its first page was read" },
      { path: "src/min.ts", reason: "long lines, only partly visible to a Read" },
      {
        path: "src/huge.ts",
        reason: "its diff is over 2 MB and was cut off; only the part shown was read",
      },
      { path: "logo.png", reason: "binary: no diff to read, and the file wasn't opened" },
    ]);
  });

  it("says which patches a check didn't read itself, tests and docs included", () => {
    const index = [
      entry("src/core.ts"),
      entry("src/core.test.ts"),
      entry("docs/x.md"),
      entry("package-lock.json", { skim: "lockfile" }),
    ];
    const tests = delegate("test-reviewer");
    const perf = delegate("performance-reviewer");
    const whole = (path: string, parent: string) =>
      readCall({ file_path: `${contextDir}/patches/${path}.diff` }, parent).line;
    const activity = activityFrom([
      tests.line,
      perf.line,
      whole("src/core.test.ts", tests.id),
      whole("docs/x.md", tests.id),
      whole("src/core.ts", perf.id),
      readCall({ file_path: `${contextDir}/patches/package-lock.json.diff`, limit: 200 }).line,
    ]);
    const { coverage, volumes } = coverageOf(index, activity, { ...where, lanes: true });
    expect(coverage.notExamined).toEqual([]);
    const gaps = Object.fromEntries(coverage.laneGaps.map((g) => [g.check, g.paths]));
    expect(gaps["Test quality"]).toEqual(["src/core.ts"]);
    expect(gaps.Performance).toEqual(["src/core.test.ts", "docs/x.md"]);
    // A check that read nothing missed every patch; skimmed bulk is never owed a whole read.
    expect(gaps.Risk).toEqual(["src/core.ts", "src/core.test.ts", "docs/x.md"]);
    expect(Object.keys(gaps)).toHaveLength(8);
    // Each agent's reading: a whole 40 KB patch per Read, and the lockfile's first page.
    expect(volumes.map((v) => [v.name, v.bytes])).toEqual([
      ["yarvis-review:test-reviewer", 80_000],
      ["yarvis-review:performance-reviewer", 40_000],
      ["main", 6667],
    ]);
  });

  it("keeps the answer with the coverage unknown when counting it fails", () => {
    const counted = safeCoverage("test", () => {
      throw new Error("boom");
    });
    expect(counted).toEqual({ coverage: { unknown: true }, volumes: [], touched: null });
  });
});
