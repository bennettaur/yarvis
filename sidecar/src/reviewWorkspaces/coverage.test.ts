import { describe, expect, it } from "bun:test";
import { StreamJsonParser } from "../agentRuns/streamJson.ts";
import { coverageOf } from "./coverage.ts";
import type { PatchIndexEntry } from "./patchFiles.ts";

const cwd = "/work/checkout";
const contextDir = "/var/folders/xy/T/yarvis-verification-abc";

function entry(path: string, overrides: Partial<PatchIndexEntry> = {}): PatchIndexEntry {
  return {
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
    ...overrides,
  };
}

let toolId = 0;

/** A stream-json `assistant` line making one Read call, as a subagent or the main agent. */
function readCall(input: Record<string, unknown>, parent: string | null = "agent-1") {
  const id = `toolu_${++toolId}`;
  return {
    id,
    line: JSON.stringify({
      type: "assistant",
      parent_tool_use_id: parent,
      message: {
        id: `msg_${id}`,
        content: [{ type: "tool_use", id, name: "Read", input }],
      },
    }),
  };
}

function resultFor(id: string, isError: boolean) {
  return JSON.stringify({
    type: "user",
    message: { content: [{ type: "tool_result", tool_use_id: id, is_error: isError }] },
  });
}

/** Feeds the lines through the run's own parser and returns the reads it kept. */
function readsFrom(lines: string[]) {
  const parser = new StreamJsonParser(cwd);
  for (const line of lines) parser.parseLine(line);
  return parser.fileReads;
}

describe("coverage from a run's reads", () => {
  const index = [
    entry("src/a.ts"),
    entry("src/b.ts"),
    entry("src/c.ts"),
    entry("src/new.ts", { status: "added", deletions: 0, hunks: [{ start: 1, count: 40 }] }),
    entry("img.png", { binary: true, patchFile: null, lines: 0, noPatch: "binary", hunks: [] }),
    entry("package-lock.json", { truncated: true, lines: 800 }),
    entry("moved.ts", { patchFile: null, lines: 0, noPatch: "no line changes", hunks: [] }),
  ];

  it("counts a patch read whole, in pages, and leaves out failed and partial reads", () => {
    const a1 = readCall({ file_path: `${contextDir}/patches/src/a.ts.diff`, limit: 800 });
    const a2 = readCall({
      // The same folder by its other spelling, and a page that overlaps.
      file_path: `/private${contextDir}/patches/src/a.ts.diff`,
      offset: 700,
      limit: 800,
    });
    // The whole of b in one go, but the tool refused it (too many tokens).
    const b = readCall({ file_path: `${contextDir}/patches/src/b.ts.diff` });
    const c = readCall({ file_path: `${contextDir}/patches/src/c.ts.diff`, limit: 600 });
    // An added file read in the checkout, by a relative path, covering its hunk.
    const fresh = readCall({ file_path: "src/new.ts" }, null);
    const lock = readCall({ file_path: `${contextDir}/patches/package-lock.json.diff` });
    const reads = readsFrom([
      a1.line,
      resultFor(a1.id, false),
      a2.line,
      b.line,
      resultFor(b.id, true),
      c.line,
      fresh.line,
      lock.line,
    ]);
    expect(reads).toHaveLength(6);
    expect(reads.find((r) => r.path.endsWith("b.ts.diff"))?.failed).toBe(true);

    expect(coverageOf(index, reads, { cwd, contextDir })).toEqual({
      examined: 3,
      total: 7,
      notExamined: [
        { path: "src/b.ts", reason: "its patch wasn't opened" },
        { path: "src/c.ts", reason: "only 600 of its patch's 1200 lines were read" },
        { path: "img.png", reason: "binary: no diff to read, and the file wasn't opened" },
        {
          path: "package-lock.json",
          reason: "its diff is too large and was cut off; only the part shown was read",
        },
      ],
    });
  });

  it("doesn't count the head file for a change that removed lines", () => {
    const read = readCall({ file_path: `${cwd}/src/a.ts` });
    expect(
      coverageOf([entry("src/a.ts")], readsFrom([read.line]), { cwd, contextDir }).notExamined,
    ).toEqual([{ path: "src/a.ts", reason: "its patch wasn't opened" }]);
  });

  it("reports nothing examined when the run read nothing", () => {
    const coverage = coverageOf(index, [], { cwd, contextDir });
    // Only the rename with no line changes has nothing to read.
    expect(coverage).toMatchObject({ examined: 1, total: 7 });
    expect(coverage.notExamined.map((n) => n.path)).not.toContain("moved.ts");
  });
});
