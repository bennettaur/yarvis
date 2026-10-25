/**
 * Coverage of the lines a pull request adds, rather than of the whole repo. A
 * single PR barely moves total coverage, so the total says almost nothing about
 * whether the new code is tested.
 */

import { isAbsolute, join, relative } from "node:path";
import { isTestFile } from "./tier.ts";

/** Line numbers each file gained, keyed by repo-relative path. */
export type AddedLines = Map<string, Set<number>>;

/** Hit count per executable line, keyed by repo-relative path. */
export type LineHits = Map<string, Map<number, number>>;

export interface DiffCoverage {
  /** Added lines the coverage tool counts as executable. */
  changedLines: number;
  coveredLines: number;
  /** `null` when no added line was executable, so there is nothing to score. */
  ratio: number | null;
  uncovered: { path: string; lines: string }[];
  /** Changed source files no test even imported. */
  notLoaded: string[];
  /** Changed source files in a language no coverage tool ran for. */
  unmeasured: string[];
}

const SOURCE_EXTENSIONS = [".ts", ".tsx", ".rs"];

/** Reads `git diff -U0` output into the line numbers each file gained. */
export function parseAddedLines(diff: string): AddedLines {
  const added: AddedLines = new Map();
  let current: Set<number> | null = null;
  let previous = "";
  for (const line of diff.split("\n")) {
    const afterOldHeader = previous.startsWith("--- ");
    previous = line;
    if (line.startsWith("diff --git ")) {
      current = null;
      continue;
    }
    // Only right after the `---` header: an added line whose text starts
    // with "++ " also begins with "+++ ".
    if (afterOldHeader && line.startsWith("+++ ")) {
      const path = line.slice(4);
      // A deleted file's new side is /dev/null and gains nothing.
      current = path === "/dev/null" ? null : new Set();
      if (current) added.set(path.replace(/^b\//, ""), current);
      continue;
    }
    const hunk = line.match(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
    if (hunk && current) {
      const start = Number(hunk[1]);
      const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
      for (let n = start; n < start + count; n++) current.add(n);
    }
  }
  return added;
}

/**
 * Reads an lcov file. `prefix` is the directory the suite ran from, relative
 * to the repo root, since bun writes paths relative to its working directory.
 * Absolute paths (cargo llvm-cov) are made relative to `repoRoot`.
 */
export function parseLcov(text: string, prefix: string, repoRoot: string): LineHits {
  const hits: LineHits = new Map();
  let current: Map<number, number> | null = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("SF:")) {
      const raw = line.slice(3).trim();
      const path = isAbsolute(raw) ? relative(repoRoot, raw) : join(prefix, raw);
      // Sources outside the repo, such as cargo's registry, can't be changed by a PR.
      if (path.startsWith("..")) {
        current = null;
        continue;
      }
      current = hits.get(path) ?? new Map();
      hits.set(path, current);
    } else if (line.startsWith("DA:") && current) {
      const [lineNo, count] = line.slice(3).split(",").map(Number);
      current.set(lineNo, Math.max(current.get(lineNo) ?? 0, count));
    }
  }
  return hits;
}

export function mergeLineHits(...sets: LineHits[]): LineHits {
  const merged: LineHits = new Map();
  for (const set of sets) {
    for (const [path, lines] of set) {
      const into = merged.get(path) ?? new Map<number, number>();
      for (const [line, count] of lines) into.set(line, Math.max(into.get(line) ?? 0, count));
      merged.set(path, into);
    }
  }
  return merged;
}

/** Collapses line numbers into ranges: [9, 3, 4, 5] becomes "3-5, 9". */
export function formatRanges(lines: number[]): string {
  const sorted = [...lines].sort((a, b) => a - b);
  const ranges: string[] = [];
  let start = sorted[0];
  let prev = start;
  // The trailing NaN never extends a range, so it flushes the last one.
  for (const n of [...sorted.slice(1), Number.NaN]) {
    if (n === prev + 1) {
      prev = n;
      continue;
    }
    ranges.push(start === prev ? `${start}` : `${start}-${prev}`);
    start = n;
    prev = n;
  }
  return ranges.join(", ");
}

/**
 * @param measuredExtensions file extensions a coverage tool ran for. A changed
 *   `.rs` file is reported as unmeasured, not untested, when Rust coverage
 *   wasn't collected.
 */
export function diffCoverage(
  added: AddedLines,
  hits: LineHits,
  measuredExtensions: string[],
): DiffCoverage {
  const result: DiffCoverage = {
    changedLines: 0,
    coveredLines: 0,
    ratio: null,
    uncovered: [],
    notLoaded: [],
    unmeasured: [],
  };

  for (const [path, lines] of added) {
    const ext = SOURCE_EXTENSIONS.find((e) => path.endsWith(e));
    if (!ext || isTestFile(path) || path.endsWith(".d.ts") || lines.size === 0) continue;
    if (!measuredExtensions.includes(ext)) {
      result.unmeasured.push(path);
      continue;
    }
    const fileHits = hits.get(path);
    if (!fileHits) {
      result.notLoaded.push(path);
      continue;
    }
    const missed: number[] = [];
    for (const line of lines) {
      // Lines lcov doesn't list are comments, types and blank lines.
      const count = fileHits.get(line);
      if (count === undefined) continue;
      result.changedLines++;
      if (count > 0) result.coveredLines++;
      else missed.push(line);
    }
    if (missed.length > 0) result.uncovered.push({ path, lines: formatRanges(missed) });
  }

  if (result.changedLines > 0) result.ratio = result.coveredLines / result.changedLines;
  return result;
}
