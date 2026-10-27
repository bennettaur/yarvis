/**
 * Which changed files a review run actually examined, from the Read calls it
 * made: the server's own count, so a report never reads as covering files its
 * agents didn't open.
 *
 * A file counts as examined when at least one agent read every line of its
 * patch, in one Read or in pages. Reading the file itself in the checkout
 * counts too, but only for a change that removes nothing (a removed line isn't
 * in the head file), and only when the reads cover every head line the patch
 * adds or keeps. What can't be shown to have been seen counts for nothing:
 *  - a read that failed (a file too big for one Read, say), or whose `offset`
 *    or `limit` wasn't a number;
 *  - a path with a `..` segment, and anything whose real path isn't the
 *    patch's or the head file's (both sides are resolved through symlinks);
 *  - a patch with lines longer than a Read shows, however much of it was read.
 * Bulk ({@link PatchIndexEntry.skim}) is "skimmed" once its first
 * {@link SKIM_LINES} lines were read. A file with no line changes, or a binary
 * file the PR deletes, has nothing to read and counts as examined; a binary
 * file the PR adds or changes counts once it was opened; and a patch cut off
 * for its size never counts, unless it is a pure addition whose head file was
 * read.
 *
 * For a verification run it also says, per check, which source files in that
 * check's lane the check itself didn't read, which the overall count hides
 * when another check read them.
 */

import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { z } from "zod";
import type { RunActivity } from "../agentRuns/service.ts";
import type { FileRead } from "../agentRuns/streamJson.ts";
import {
  type HeadRange,
  PATCH_LIMITS,
  type PatchIndexEntry,
  SKIM_LINES,
  sizeText,
} from "./patchFiles.ts";

/** Lines a Read returns when it gives no `limit`: Claude Code's default. */
export const READ_DEFAULT_LIMIT = 2000;

export const coverageSchema = z.object({
  /** Files at least one agent read in full. */
  examined: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  /** Bulk whose first page was read, which is all it is owed. */
  skimmed: z.array(z.object({ path: z.string(), kind: z.string() })),
  /** In the index's order. */
  notExamined: z.array(z.object({ path: z.string(), reason: z.string() })),
  /** Per check: source files in its lane it didn't read, though another check did. */
  laneGaps: z.array(z.object({ check: z.string(), paths: z.array(z.string()) })),
});

export type Coverage = z.infer<typeof coverageSchema>;
export type NotExamined = Coverage["notExamined"][number];

/** Stands in for coverage when counting it failed: the answer stays, the count is unknown. */
export interface UnknownCoverage {
  unknown: true;
}

/** Bytes of patch one agent (or the main thread) read, re-reads included: how close it came to compacting. */
export interface ReadVolume {
  subagentId: string | null;
  name: string;
  bytes: number;
}

/** The verification checks with a lane, by their subagent type. */
const LANE_CHECKS: Record<string, string> = {
  "yarvis-review:risk-reviewer": "Risk",
  "yarvis-review:completeness-reviewer": "Completeness",
  "yarvis-review:test-reviewer": "Test quality",
  "yarvis-review:complexity-reviewer": "Complexity",
  "yarvis-review:performance-reviewer": "Performance",
  "yarvis-review:comment-reviewer": "Comment quality",
  "yarvis-review:observability-reviewer": "Observability",
  "yarvis-review:quality-reviewer": "Code quality",
};

const SOURCE_FILE =
  /\.(ts|tsx|js|jsx|mjs|cjs|py|rb|go|rs|java|kt|kts|swift|c|cc|cpp|h|hpp|cs|php|scala|m|mm|sql|sh|vue|svelte)$/;
const TEST_FILE = /(^|\/)(test|tests|__tests__|spec|specs)\/|[._-](test|spec)\.[^/]+$|_test\.go$/;

/** Application source, which every lane-bound check is told to read. */
export const isSourceFile = (path: string) => SOURCE_FILE.test(path) && !TEST_FILE.test(path);

/**
 * A path's canonical form: resolved against `cwd`, through symlinks when it
 * exists, else with macOS's `/private` temp prefix taken off. Null for a path
 * with a `..` segment, which never counts.
 */
function canonical(path: string, cwd: string): string | null {
  if (path.split(/[\\/]/).includes("..")) return null;
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  try {
    return realpathSync(absolute);
  } catch {
    return absolute.replace(/^\/private(?=\/(?:var|tmp)\/)/, "");
  }
}

interface ReadMap {
  /** Merged line ranges read, per canonical path. */
  ranges: Map<string, HeadRange[]>;
  /** Canonical paths a read of failed. */
  failed: Set<string>;
}

function readMap(reads: FileRead[], cwd: string): ReadMap {
  const byPath = new Map<string, HeadRange[]>();
  const failed = new Set<string>();
  for (const read of reads) {
    const key = canonical(read.path, cwd);
    if (key === null || read.malformed) continue;
    if (read.failed) {
      failed.add(key);
      continue;
    }
    const start = Math.max(1, Math.floor(read.offset ?? 1));
    const limit = read.limit === null ? READ_DEFAULT_LIMIT : Math.floor(read.limit);
    if (limit < 1) continue;
    const list = byPath.get(key) ?? [];
    list.push({ start, end: start + limit - 1 });
    byPath.set(key, list);
  }
  for (const [key, list] of byPath) {
    list.sort((a, b) => a.start - b.start);
    const merged: HeadRange[] = [];
    for (const r of list) {
      const last = merged.at(-1);
      if (last && r.start <= last.end + 1) last.end = Math.max(last.end, r.end);
      else merged.push({ ...r });
    }
    byPath.set(key, merged);
  }
  return { ranges: byPath, failed };
}

/** How many of lines `range.start..range.end` the ranges cover. */
function coveredLines(ranges: HeadRange[] | undefined, range: HeadRange): number {
  let n = 0;
  for (const r of ranges ?? []) {
    const start = Math.max(r.start, range.start);
    const end = Math.min(r.end, range.end);
    if (end >= start) n += end - start + 1;
  }
  return n;
}

const covers = (ranges: HeadRange[] | undefined, range: HeadRange) =>
  coveredLines(ranges, range) === range.end - range.start + 1;

type Verdict = { state: "examined" } | { state: "skimmed" } | { state: "gap"; reason: string };

interface Where {
  cwd: string;
  contextDir: string;
}

/** The canonical paths an entry can be read at: its patch and its head file. */
function keysOf(entry: PatchIndexEntry, where: Where) {
  return {
    patch: entry.patchFile ? canonical(`${where.contextDir}/${entry.patchFile}`, where.cwd) : null,
    head: canonical(entry.path, where.cwd),
  };
}

/** Whether `reads` examined `entry`, by the rules in the module comment. */
function judge(entry: PatchIndexEntry, reads: ReadMap, where: Where): Verdict {
  const keys = keysOf(entry, where);
  const headReads = keys.head ? reads.ranges.get(keys.head) : undefined;
  if (entry.binary) {
    if (entry.status === "deleted" || headReads) return { state: "examined" };
    return { state: "gap", reason: "binary: no diff to read, and the file wasn't opened" };
  }
  if (!entry.patchFile) {
    return entry.noPatch === "no line changes"
      ? { state: "examined" }
      : { state: "gap", reason: `no patch (${entry.noPatch})` };
  }
  // A rename or mode change: git's header says it all, and the index gives that.
  if (entry.hunks.length === 0 && !entry.truncated) return { state: "examined" };

  const patchReads = keys.patch ? reads.ranges.get(keys.patch) : undefined;
  const whole = { start: 1, end: entry.lines };
  const read = coveredLines(patchReads, whole);
  if (entry.skim) {
    return covers(patchReads, { start: 1, end: Math.min(entry.lines, SKIM_LINES) })
      ? { state: "skimmed" }
      : { state: "gap", reason: `${entry.skim}, and not even its first page was read` };
  }
  // The head file shows everything a change that removes nothing did.
  const headRanges = entry.hunks
    .filter((h) => h.count > 0)
    .map((h) => ({ start: h.start, end: h.start + h.count - 1 }));
  const headCovered =
    entry.deletions === 0 && headRanges.length > 0 && headRanges.every((r) => covers(headReads, r));
  if (headCovered && entry.longLines === 0) return { state: "examined" };
  if (entry.truncated) {
    const cut = `its diff is over ${sizeText(PATCH_LIMITS.maxPatchBytes)} and was cut off`;
    return {
      state: "gap",
      reason:
        read === entry.lines
          ? `${cut}; only the part shown was read`
          : `${cut}, and the run didn't read all of the part shown`,
    };
  }
  if (read === entry.lines) {
    return entry.longLines > 0
      ? { state: "gap", reason: "long lines, only partly visible to a Read" }
      : { state: "examined" };
  }
  if (read === 0) {
    return {
      state: "gap",
      reason:
        keys.patch && reads.failed.has(keys.patch)
          ? "the read failed; it wasn't re-read in pages"
          : "its patch wasn't opened",
    };
  }
  const long = entry.longLines > 0 ? "; long lines, only partly visible" : "";
  return {
    state: "gap",
    reason: `only ${read} of its patch's ${entry.lines} lines were read${long}`,
  };
}

/** The bytes of patch each agent read, from its reads' line ranges. */
function readVolumes(
  entries: PatchIndexEntry[],
  activity: RunActivity,
  where: Where,
): ReadVolume[] {
  const patches = new Map<string, PatchIndexEntry>();
  for (const e of entries) {
    const key = keysOf(e, where).patch;
    if (key && e.lines > 0) patches.set(key, e);
  }
  const totals = new Map<string | null, number>();
  for (const read of activity.reads) {
    const key = canonical(read.path, where.cwd);
    const e = key ? patches.get(key) : undefined;
    if (!e || read.failed || read.malformed) continue;
    const start = Math.max(1, read.offset ?? 1);
    const asked = read.limit === null ? READ_DEFAULT_LIMIT : Math.max(0, read.limit);
    const lines = Math.max(0, Math.min(asked, e.lines - start + 1));
    totals.set(
      read.subagentId,
      (totals.get(read.subagentId) ?? 0) + Math.round((lines * e.bytes) / e.lines),
    );
  }
  return [...totals].map(([subagentId, bytes]) => ({
    subagentId,
    name: subagentId === null ? "main" : (activity.subagents.get(subagentId) ?? "unknown"),
    bytes,
  }));
}

export interface CoverageResult {
  coverage: Coverage;
  /** Each agent's patch reading, for the run's meta. */
  volumes: ReadVolume[];
  /** Paths whose patch or head file was read at all. */
  touched: Set<string>;
}

/**
 * Which of `entries` the run examined. With `lanes`, also which source files
 * each verification check missed in its own lane.
 */
export function coverageOf(
  entries: PatchIndexEntry[],
  activity: RunActivity,
  where: Where & { lanes?: boolean },
): CoverageResult {
  const all = readMap(activity.reads, where.cwd);
  const skimmed: Coverage["skimmed"] = [];
  const notExamined: NotExamined[] = [];
  const examinedPaths: PatchIndexEntry[] = [];
  const touched = new Set<string>();
  for (const entry of entries) {
    const keys = keysOf(entry, where);
    if ((keys.patch && all.ranges.has(keys.patch)) || (keys.head && all.ranges.has(keys.head))) {
      touched.add(entry.path);
    }
    const verdict = judge(entry, all, where);
    if (verdict.state === "examined") examinedPaths.push(entry);
    else if (verdict.state === "skimmed")
      skimmed.push({ path: entry.path, kind: entry.skim ?? "" });
    else notExamined.push({ path: entry.path, reason: verdict.reason });
  }

  const laneGaps: Coverage["laneGaps"] = [];
  if (where.lanes) {
    const sources = examinedPaths.filter((e) => isSourceFile(e.path) && e.patchFile);
    for (const [type, check] of Object.entries(LANE_CHECKS)) {
      const ids = new Set(
        [...activity.subagents].filter(([, name]) => name === type).map(([id]) => id),
      );
      const own = readMap(
        activity.reads.filter((r) => r.subagentId !== null && ids.has(r.subagentId)),
        where.cwd,
      );
      const missed = sources.filter((e) => judge(e, own, where).state !== "examined");
      if (missed.length > 0) laneGaps.push({ check, paths: missed.map((e) => e.path) });
    }
  }

  return {
    coverage: {
      examined: examinedPaths.length,
      total: entries.length,
      skimmed,
      notExamined,
      laneGaps,
    },
    volumes: readVolumes(entries, activity, where),
    touched,
  };
}

/**
 * {@link coverageOf} for a run's finishing step, which must not throw: a
 * count that fails, or comes out in a shape it shouldn't, leaves the paid-for
 * answer in place with the coverage marked unknown, and is logged.
 */
export function safeCoverage(
  label: string,
  count: () => CoverageResult,
): CoverageResult | { coverage: UnknownCoverage; volumes: ReadVolume[]; touched: null } {
  try {
    const result = count();
    coverageSchema.parse(result.coverage);
    return result;
  } catch (e) {
    console.error(`[${label}] could not count which files the run read:`, e);
    return { coverage: { unknown: true }, volumes: [], touched: null };
  }
}
