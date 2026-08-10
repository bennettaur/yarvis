/**
 * Parses a unified-diff patch into rows for rendering, tracking both files'
 * line numbers per row. The right (new file) line is what GitHub and Azure both
 * use to anchor a line comment, so it doubles as the comment target; the left
 * (old file) line only surfaces in the side-by-side view.
 */

export type DiffRowKind = "hunk" | "add" | "del" | "context" | "meta";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Right-file line number for add/context rows; null otherwise. */
  rightLine: number | null;
  /** Left-file line number for del/context rows; null otherwise. */
  leftLine: number | null;
}

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let rightLine = 0;
  let leftLine = 0;
  // A raw `git diff` prefixes each file with a control block (`diff --git`,
  // `index`, mode lines, `--- `/`+++ `) that ends at the first hunk. GitHub PR
  // patches omit it, but a workspace file diff includes it. It carries no
  // source lines, so skip it entirely — rendering it would show git plumbing
  // and, worse, the `+++`/context header lines would advance the line counter.
  let inFileHeader = false;
  for (const text of patch.split("\n")) {
    if (text.startsWith("diff --git")) {
      inFileHeader = true;
      continue;
    }
    if (text.startsWith("@@")) {
      inFileHeader = false;
      // `@@ -a,b +c,d @@` — a and c are the hunk's first left/right lines.
      const right = text.match(/\+(\d+)/);
      const left = text.match(/-(\d+)/);
      rightLine = right ? Number(right[1]) : 0;
      leftLine = left ? Number(left[1]) : 0;
      rows.push({ kind: "hunk", text, rightLine: null, leftLine: null });
      continue;
    }
    if (inFileHeader) continue;
    if (text.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, not a real line.
      rows.push({ kind: "meta", text, rightLine: null, leftLine: null });
    } else if (text.startsWith("+")) {
      rows.push({ kind: "add", text, rightLine, leftLine: null });
      rightLine++;
    } else if (text.startsWith("-")) {
      rows.push({ kind: "del", text, rightLine: null, leftLine });
      leftLine++;
    } else {
      rows.push({ kind: "context", text, rightLine, leftLine });
      rightLine++;
      leftLine++;
    }
  }
  return rows;
}

/**
 * One side of a side-by-side row. `text` has the unified-diff marker column
 * stripped: which side a line sits on and how it changed are already carried by
 * the column and the row color, so repeating `+`/`-` in the code itself only
 * pushes every line one character out of alignment with its counterpart.
 */
export interface SplitCell {
  kind: "add" | "del" | "context";
  text: string;
  line: number | null;
}

/**
 * A row of the side-by-side view. Hunk headers and `\ No newline` markers
 * belong to neither file, so they span the full width instead of being paired.
 */
export type SplitRow =
  | { kind: "hunk"; text: string }
  | { kind: "meta"; text: string }
  | { kind: "pair"; left: SplitCell | null; right: SplitCell | null };

/** Strips the leading marker column (`+`, `-`, or space) from a patch line. */
function body(text: string): string {
  return /^[+\- ]/.test(text) ? text.slice(1) : text;
}

/**
 * Folds unified rows into aligned left/right pairs for the side-by-side view.
 *
 * Within a run of changed lines, the nth deletion is shown across from the nth
 * addition — a rewritten line then sits beside the line it replaced, which is
 * the entire reason to read a diff this way. Runs of unequal length pad with a
 * blank on the shorter side. Deletions and additions are buffered separately so
 * the pairing holds no matter which order a provider emits them in.
 */
export function pairRows(rows: DiffRow[]): SplitRow[] {
  const out: SplitRow[] = [];
  let dels: SplitCell[] = [];
  let adds: SplitCell[] = [];

  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      out.push({ kind: "pair", left: dels[i] ?? null, right: adds[i] ?? null });
    }
    dels = [];
    adds = [];
  };

  for (const row of rows) {
    if (row.kind === "del") {
      dels.push({ kind: "del", text: body(row.text), line: row.leftLine });
      continue;
    }
    if (row.kind === "add") {
      adds.push({ kind: "add", text: body(row.text), line: row.rightLine });
      continue;
    }
    // Anything else ends the run of changed lines and closes out its pairing.
    flush();
    if (row.kind === "hunk") {
      out.push({ kind: "hunk", text: row.text });
    } else if (row.kind === "meta") {
      out.push({ kind: "meta", text: row.text });
    } else {
      const text = body(row.text);
      out.push({
        kind: "pair",
        left: { kind: "context", text, line: row.leftLine },
        right: { kind: "context", text, line: row.rightLine },
      });
    }
  }
  flush();
  return out;
}
