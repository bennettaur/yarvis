/**
 * Rebuilds the old side of a change from the new side and the patch.
 *
 * Syntax coloring needs whole files, not the fragments a patch carries — the
 * body of a block comment only reads as one if the lexer saw where it opened.
 * The new file can be fetched, but the old one is a second request against a
 * commit neither provider hands us: what a PR diff is taken against is the
 * merge base, and both APIs offer the base branch's tip instead, which has
 * moved on whenever the base branch has.
 *
 * A patch is a complete account of the difference between the two, so reversing
 * it onto the new file yields the old one exactly, with nothing to fetch and no
 * commit to guess at.
 */

import { type DiffRow, diffBody } from "./diff";

/** `@@ -oldStart,oldCount +newStart,newCount @@`; a missing count means 1. */
const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  /** First line of the new file this hunk covers, 1-based. */
  newStart: number;
  newCount: number;
  /** The hunk's view of the new file, which must match what we fetched. */
  newLines: string[];
  /** What those lines were before the change. */
  oldLines: string[];
}

function collectHunks(rows: DiffRow[]): Hunk[] | null {
  const hunks: Hunk[] = [];
  let current: Hunk | null = null;
  for (const row of rows) {
    if (row.kind === "hunk") {
      const header = HUNK_HEADER.exec(row.text);
      if (!header) return null;
      current = {
        newStart: Number(header[3]),
        newCount: header[4] === undefined ? 1 : Number(header[4]),
        newLines: [],
        oldLines: [],
      };
      hunks.push(current);
      continue;
    }
    // "\ No newline at end of file" describes the line above rather than being
    // one, and this reconstruction is line-based, so it has nothing to say here.
    if (row.kind === "meta") continue;
    // A body row before any header means the patch was cut off at the front.
    if (!current) return null;
    const body = diffBody(row.text);
    if (row.kind === "add") {
      current.newLines.push(body);
    } else if (row.kind === "del") {
      current.oldLines.push(body);
    } else {
      current.newLines.push(body);
      current.oldLines.push(body);
    }
  }
  return hunks;
}

/**
 * Drops the empty row a patch that ends in a newline leaves behind.
 *
 * `parsePatch` splits on newlines, so a trailing one yields a final empty
 * string it reads as a context row. It costs the views nothing, but here it is
 * a line the hunk claims to cover that the file doesn't have, which would fail
 * every check below. A real line always carries its marker column, so an empty
 * `text` can only be the split's own leftover.
 */
function withoutTrailingBlank(rows: DiffRow[]): DiffRow[] {
  const last = rows[rows.length - 1];
  return last?.kind === "context" && last.text === "" ? rows.slice(0, -1) : rows;
}

/**
 * The old file's lines, or null when the patch and the file don't corroborate
 * each other.
 *
 * Every hunk is checked against the lines it claims to cover before anything is
 * rebuilt, because the two do come apart in practice: providers truncate the
 * patch of a large file, and the content fetch can land on a newer commit than
 * the diff was taken at. A reconstruction built on either would color the old
 * side against lines it doesn't have, which is worse than leaving it plain —
 * so a mismatch declines rather than guessing.
 */
export function baseFileLines(headLines: string[], rows: DiffRow[]): string[] | null {
  const hunks = collectHunks(withoutTrailingBlank(rows));
  if (!hunks) return null;

  const out: string[] = [];
  let cursor = 0;
  for (const hunk of hunks) {
    if (hunk.newLines.length !== hunk.newCount) return null;
    // A hunk that adds to an empty stretch is written `+n,0`, where n is the
    // line it goes after rather than a line it covers.
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < cursor || start + hunk.newCount > headLines.length) return null;
    for (let i = cursor; i < start; i++) out.push(headLines[i]);
    for (let i = 0; i < hunk.newCount; i++) {
      if (headLines[start + i] !== hunk.newLines[i]) return null;
    }
    // Pushed one at a time rather than spread: a whole-file rewrite puts the
    // entire file in `oldLines`, and a spread passes one argument per line —
    // past roughly 65k arguments the engine throws instead of returning.
    for (const line of hunk.oldLines) out.push(line);
    cursor = start + hunk.newCount;
  }
  for (let i = cursor; i < headLines.length; i++) out.push(headLines[i]);
  return out;
}
