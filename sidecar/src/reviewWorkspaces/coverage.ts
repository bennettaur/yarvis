/**
 * Which changed files a review run actually examined, from the Read calls it
 * made: the server's own count, so a report never reads as covering files its
 * agents didn't open.
 *
 * A file counts as examined when the run read every line of its patch, in one
 * Read or in pages. Reading the file itself in the checkout counts too, but
 * only for a change that removes nothing (a removed line isn't in the head
 * file), and only when the reads cover every head line the patch adds or
 * keeps. A read that failed (a file too big for one Read, say) counts for
 * nothing. A file with no line changes (a rename, a mode change) has nothing
 * to read and counts as examined; a binary one counts only when the run opened it, and one whose
 * patch was cut off for its size never does.
 */

import { isAbsolute, resolve } from "node:path";
import type { FileRead } from "../agentRuns/streamJson.ts";
import type { HeadRange, PatchIndexEntry } from "./patchFiles.ts";

/** Lines a Read returns when it gives no `limit`: Claude Code's default. */
export const READ_DEFAULT_LIMIT = 2000;

export interface NotExamined {
  path: string;
  reason: string;
}

export interface Coverage {
  examined: number;
  total: number;
  /** In the index's order. */
  notExamined: NotExamined[];
}

/**
 * macOS's temp folder is reached through `/var → /private/var`, and a tool
 * may report either spelling; both are made the short one.
 */
function normalize(path: string, cwd: string): string {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  return absolute.replace(/^\/private(?=\/(?:var|tmp)\/)/, "");
}

/** Merged, sorted line ranges each path was read over, failed reads left out. */
function readRanges(reads: FileRead[], cwd: string): Map<string, HeadRange[]> {
  const byPath = new Map<string, HeadRange[]>();
  for (const read of reads) {
    if (read.failed) continue;
    const start = Math.max(1, Math.floor(read.offset ?? 1));
    const limit = read.limit && read.limit > 0 ? Math.floor(read.limit) : READ_DEFAULT_LIMIT;
    const key = normalize(read.path, cwd);
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
  return byPath;
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

/** Why a file wasn't examined, or null when it was. */
function gap(
  entry: PatchIndexEntry,
  ranges: Map<string, HeadRange[]>,
  where: { cwd: string; contextDir: string },
): string | null {
  const headFile = ranges.get(normalize(entry.path, where.cwd));
  if (entry.binary) {
    return headFile ? null : "binary: no diff to read, and the file wasn't opened";
  }
  if (!entry.patchFile) {
    return entry.noPatch === "no line changes" ? null : `no patch (${entry.noPatch})`;
  }
  // A rename or mode change: git's header says it all, and the index gives that.
  if (entry.hunks.length === 0 && !entry.truncated) return null;
  const patchReads = ranges.get(normalize(`${where.contextDir}/${entry.patchFile}`, where.cwd));
  const whole = { start: 1, end: entry.lines };
  const readWhole = covers(patchReads, whole);
  if (entry.truncated) {
    return readWhole
      ? "its diff is too large and was cut off; only the part shown was read"
      : "its diff is too large and was cut off, and the run didn't read all of the part shown";
  }
  if (readWhole) return null;
  // The head file shows everything a change that removes nothing did.
  const headRanges = entry.hunks
    .filter((h) => h.count > 0)
    .map((h) => ({ start: h.start, end: h.start + h.count - 1 }));
  if (
    entry.deletions === 0 &&
    headRanges.length > 0 &&
    headRanges.every((r) => covers(headFile, r))
  ) {
    return null;
  }
  const read = coveredLines(patchReads, whole);
  return read === 0
    ? "its patch wasn't opened"
    : `only ${read} of its patch's ${entry.lines} lines were read`;
}

/** Which of `entries` the run's `reads` examined, by the rules in the module comment. */
export function coverageOf(
  entries: PatchIndexEntry[],
  reads: FileRead[],
  where: { cwd: string; contextDir: string },
): Coverage {
  const ranges = readRanges(reads, where.cwd);
  const notExamined: NotExamined[] = [];
  for (const entry of entries) {
    const reason = gap(entry, ranges, where);
    if (reason) notExamined.push({ path: entry.path, reason });
  }
  return {
    examined: entries.length - notExamined.length,
    total: entries.length,
    notExamined,
  };
}
