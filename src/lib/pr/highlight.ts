/**
 * Maps a patch's rows onto syntax-coloured HTML.
 *
 * A diff holds two files, not one, so each side is coloured as its own
 * document: feeding the lexer a single stream of interleaved additions and
 * deletions would have it reading a line and its replacement as consecutive
 * code. The results are then looked up by that side's own line numbering,
 * which is what every view already has in hand for a row or a split cell.
 *
 * Given the new file's text, both sides are coloured from the whole file — the
 * old one rebuilt by reversing the patch (see `baseFile.ts`). Without it, all
 * there is to work with is the lines the patch carries, and a hunk that opens
 * inside a block comment or a template literal has no way to know it: the
 * fragment is coloured as if the file started there. That fallback is what the
 * views show until the file's content arrives, and all they ever get where
 * there is no commit to read it at.
 */

import { highlightLines, languageForPath } from "../highlight";
import { baseFileLines } from "./baseFile";
import { type DiffRow, diffBody, type SplitCell } from "./diff";

export interface DiffHighlight {
  /** Coloured HTML for a line of the old file, or null if unavailable. */
  left(line: number | null): string | null;
  /** Coloured HTML for a line of the new file, or null if unavailable. */
  right(line: number | null): string | null;
}

/** Used for files we have no grammar for, and when colouring is skipped. */
const PLAIN: DiffHighlight = { left: () => null, right: () => null };

type Side = "left" | "right";

/** A whole file's colouring, keyed by its own 1-based line numbers. */
function wholeFile(lines: string[], language: string): Map<number, string> | null {
  const highlighted = highlightLines(lines.join("\n"), language);
  if (!highlighted || highlighted.length !== lines.length) return null;
  const byLine = new Map<number, string>();
  for (let i = 0; i < highlighted.length; i++) byLine.set(i + 1, highlighted[i]);
  return byLine;
}

/**
 * The lines of one side of the diff, paired with their numbers in that file.
 *
 * Rows the reader hasn't expanded leave the side discontinuous — a hunk can
 * pick up a hundred lines further down. The lexer is handed the visible lines
 * anyway: a run of code with a stretch missing from the middle still colours
 * far better than each of its lines tokenised alone.
 */
function sideLines(rows: DiffRow[], side: Side): { numbers: (number | null)[]; text: string } {
  const kept = side === "left" ? ["del", "context"] : ["add", "context"];
  const numbers: (number | null)[] = [];
  const lines: string[] = [];
  for (const row of rows) {
    if (!kept.includes(row.kind)) continue;
    numbers.push(side === "left" ? row.leftLine : row.rightLine);
    lines.push(diffBody(row.text));
  }
  return { numbers, text: lines.join("\n") };
}

/** One side coloured from the patch alone, for want of the file it came from. */
function fromPatch(rows: DiffRow[], side: Side, language: string): Map<number, string> {
  const { numbers, text } = sideLines(rows, side);
  const byLine = new Map<number, string>();
  const highlighted = highlightLines(text, language);
  // `highlightLines` splits on the newlines it was given, so a length mismatch
  // means the markup didn't survive the split. Colouring the wrong lines is
  // worse than colouring none, so drop the side entirely.
  if (!highlighted || highlighted.length !== numbers.length) return byLine;
  for (let i = 0; i < numbers.length; i++) {
    const line = numbers[i];
    const html = highlighted[i];
    if (line != null && html !== undefined) byLine.set(line, html);
  }
  return byLine;
}

/**
 * Colours both sides of a file's rows, keyed by line number.
 *
 * `headLines` is the new file's full text where the view has it, empty until it
 * loads and where no commit is on offer to read it at.
 */
export function highlightDiff(
  rows: DiffRow[],
  path: string,
  headLines: string[] = [],
): DiffHighlight {
  const language = languageForPath(path);
  if (!language) return PLAIN;

  const sides = (left: Map<number, string>, right: Map<number, string>): DiffHighlight => ({
    left: (line) => (line == null ? null : (left.get(line) ?? null)),
    right: (line) => (line == null ? null : (right.get(line) ?? null)),
  });

  // Nothing fetched yet, or no commit to read the file at: the patch's own
  // lines are all there is to work with.
  if (headLines.length === 0) {
    return sides(fromPatch(rows, "left", language), fromPatch(rows, "right", language));
  }

  const head = wholeFile(headLines, language);
  // A file past the size caps gets no colouring at all rather than falling back
  // to its patch's fragments. The caps are a judgement that this file is
  // generated or minified — output nobody reads a token at a time — and
  // colouring the slice of it a diff happens to show doesn't change that.
  if (!head) return PLAIN;

  const baseLines = baseFileLines(headLines, rows);
  const base = baseLines ? wholeFile(baseLines, language) : null;
  // The old side falls back where the rebuild was declined or the rebuilt file
  // is itself too large: the patch's fragments are still self-consistent, and
  // the new side is unaffected either way.
  return sides(base ?? fromPatch(rows, "left", language), head);
}

/**
 * Coloured HTML for a unified-diff row, marker column included so the row still
 * lines up with its neighbours. Null for rows that aren't source code, and for
 * anything the highlighter didn't reach.
 */
export function rowHtml(row: DiffRow, highlight: DiffHighlight): string | null {
  if (row.kind === "hunk" || row.kind === "meta") return null;
  const body = row.kind === "del" ? highlight.left(row.leftLine) : highlight.right(row.rightLine);
  if (!body) return null;
  // Only ever `+`, `-` or a space, so there is nothing here to escape.
  const marker = /^[+\- ]/.test(row.text) ? row.text.slice(0, 1) : "";
  return marker + body;
}

/** Coloured HTML for a side-by-side cell, whose marker column is already gone. */
export function cellHtml(cell: SplitCell, highlight: DiffHighlight): string | null {
  return cell.kind === "del" ? highlight.left(cell.line) : highlight.right(cell.line);
}
