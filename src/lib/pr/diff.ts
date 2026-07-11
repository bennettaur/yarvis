/**
 * Parses a unified-diff patch into rows for rendering, tracking the right-side
 * (new file) line number per row. The right line is what GitHub and Azure both
 * use to anchor a line comment, so it doubles as the comment target.
 */

export type DiffRowKind = "hunk" | "add" | "del" | "context" | "meta";

export interface DiffRow {
  kind: DiffRowKind;
  text: string;
  /** Right-file line number for add/context rows; null otherwise. */
  rightLine: number | null;
}

export function parsePatch(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let rightLine = 0;
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
      // `@@ -a,b +c,d @@` — c is the first right-side line of the hunk.
      const match = text.match(/\+(\d+)/);
      rightLine = match ? Number(match[1]) : 0;
      rows.push({ kind: "hunk", text, rightLine: null });
      continue;
    }
    if (inFileHeader) continue;
    if (text.startsWith("\\")) {
      // "\ No newline at end of file" — metadata, not a real line.
      rows.push({ kind: "meta", text, rightLine: null });
    } else if (text.startsWith("+")) {
      rows.push({ kind: "add", text, rightLine });
      rightLine++;
    } else if (text.startsWith("-")) {
      rows.push({ kind: "del", text, rightLine: null });
    } else {
      rows.push({ kind: "context", text, rightLine });
      rightLine++;
    }
  }
  return rows;
}
