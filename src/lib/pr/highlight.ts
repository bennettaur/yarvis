/**
 * Maps a patch's rows onto syntax-coloured HTML.
 *
 * A diff holds two files, not one, so each side is coloured as its own
 * document: feeding the lexer a single stream of interleaved additions and
 * deletions would have it reading a line and its replacement as consecutive
 * code. The results are then looked up by that side's own line numbering,
 * which is what every view already has in hand for a row or a split cell.
 */

import { highlightLines, languageForPath } from "../highlight";
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

function sideHighlight(rows: DiffRow[], side: Side, language: string): Map<number, string> {
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

/** Colours both sides of a file's rows, keyed by line number. */
export function highlightDiff(rows: DiffRow[], path: string): DiffHighlight {
  const language = languageForPath(path);
  if (!language) return PLAIN;
  const left = sideHighlight(rows, "left", language);
  const right = sideHighlight(rows, "right", language);
  return {
    left: (line) => (line == null ? null : (left.get(line) ?? null)),
    right: (line) => (line == null ? null : (right.get(line) ?? null)),
  };
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
