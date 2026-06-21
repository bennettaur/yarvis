import { createPatch } from "diff";

/**
 * Azure DevOps has no endpoint that returns a ready unified-diff patch, so we
 * fetch both sides of a file and compute the diff here. The output matches the
 * shape GitHub returns (`patch` starting at the first `@@` hunk header), so the
 * frontend renders both providers with one code path.
 */
export interface BuiltDiff {
  /** Unified-diff text starting at `@@`, or null when there is nothing to show. */
  patch: string | null;
  additions: number;
  deletions: number;
}

/**
 * Builds a unified-diff patch between a file's base and head content. jsdiff's
 * `createPatch` prefixes an `Index:`/`---`/`+++` header; we drop everything
 * before the first hunk so the result is just `@@ … @@` plus body lines — the
 * same slice GitHub's `pulls/:n/files` `patch` field contains.
 */
export function buildPatch(filename: string, base: string, head: string): BuiltDiff {
  if (base === head) return { patch: null, additions: 0, deletions: 0 };

  const raw = createPatch(filename, base, head);
  const hunkStart = raw.indexOf("@@");
  if (hunkStart === -1) return { patch: null, additions: 0, deletions: 0 };

  const patch = raw.slice(hunkStart).replace(/\s+$/, "");
  let additions = 0;
  let deletions = 0;
  for (const line of patch.split("\n")) {
    // After the slice there are no `+++`/`---` header lines; hunk headers start
    // with `@`, so a leading `+`/`-` is unambiguously an added/removed line.
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { patch, additions, deletions };
}
