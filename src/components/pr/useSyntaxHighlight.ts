import { useMemo } from "react";
import { usePrFileContent } from "../../lib/pr/cache";
import { parsePatch } from "../../lib/pr/diff";
import { toFileLines } from "../../lib/pr/expand";
import { type DiffHighlight, highlightDiff } from "../../lib/pr/highlight";
import type { PrRef } from "../../lib/pr/types";

/**
 * A file's syntax colouring, read from its whole text rather than its patch.
 *
 * The content fetch is the same one {@link useFileExpansion} makes and hits the
 * same cache entry, so a file the reader has also asked for context in costs
 * one request between them. Unlike that one it isn't held back until something
 * is asked for: colouring is wanted the moment the diff is on screen, and the
 * fragments in a patch can't supply it — a hunk opening inside a block comment
 * has no way to know that from the lines it carries.
 *
 * Only files whose diff is open fetch anything. Diffs open a few at a time as
 * the reader scrolls toward them, so this costs a request per file actually
 * looked at, not per file in the review.
 */
export function useSyntaxHighlight(
  prRef: PrRef,
  path: string,
  patch: string,
  headSha: string,
): DiffHighlight {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const content = usePrFileContent(prRef, path, headSha, Boolean(headSha));
  const headLines = useMemo(() => toFileLines(content.data ?? ""), [content.data]);
  // Until the content lands — and for a provider that gave us no commit to read
  // it at — this falls back to colouring the patch's own lines.
  return useMemo(() => highlightDiff(rows, path, headLines), [rows, path, headLines]);
}
