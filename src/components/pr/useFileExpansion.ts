import { useCallback, useMemo, useState } from "react";
import { usePrFileContent } from "../../lib/pr/cache";
import { parsePatch } from "../../lib/pr/diff";
import {
  type ExpandedRow,
  type Expansions,
  expandAllGaps,
  expandGap,
  expandGapFully,
  expandRows,
  type Gap,
  toFileLines,
} from "../../lib/pr/expand";
import type { PrRef } from "../../lib/pr/types";

export interface FileExpansion {
  /** Patch rows with the revealed context spliced in, ready to render. */
  rows: ExpandedRow[];
  /** The head file's length, once known; 0 until its content loads. */
  totalLines: number;
  /** A requested expansion is still waiting on the file's content. */
  loading: boolean;
  error: string | null;
  expand: (gap: Gap, edge: "top" | "bottom") => void;
  expandFully: (gap: Gap) => void;
  /** Whether the whole file is being shown, changes highlighted in place. */
  wholeFile: boolean;
  setWholeFile: (value: boolean) => void;
  /** False when the provider hasn't given us a commit to read the file at. */
  canExpand: boolean;
}

/**
 * Reveals the code a patch left out, on demand.
 *
 * The file's full text is only fetched once the reader actually asks for
 * context — the gap markers size themselves from the hunk headers, so they can
 * be offered before anything is loaded. That matters on a large review, where
 * eagerly pulling every changed file's full text would double the request count
 * to serve context most files never get asked for.
 */
export function useFileExpansion(
  prRef: PrRef,
  path: string,
  patch: string,
  headSha: string,
): FileExpansion {
  const [expansions, setExpansions] = useState<Expansions>(new Map());
  const [wholeFile, setWholeFile] = useState(false);

  const rows = useMemo(() => parsePatch(patch), [patch]);
  // Nothing has been asked for yet, so nothing is fetched yet.
  const wanted = wholeFile || expansions.size > 0;
  const content = usePrFileContent(prRef, path, headSha, wanted && Boolean(headSha));
  const lines = useMemo(() => toFileLines(content.data ?? ""), [content.data]);

  // Showing the whole file is every gap opened at once; deriving it rather than
  // writing it into state keeps the toggle reversible — turning it back off
  // restores whatever the reader had expanded by hand.
  const effective = useMemo(
    () => (wholeFile && lines.length > 0 ? expandAllGaps(rows, lines.length) : expansions),
    [wholeFile, lines.length, rows, expansions],
  );

  const expanded = useMemo(() => expandRows(rows, lines, effective), [rows, lines, effective]);

  return {
    rows: expanded,
    totalLines: lines.length,
    loading: wanted && content.loading,
    error: content.error,
    expand: useCallback(
      (gap: Gap, edge: "top" | "bottom") =>
        setExpansions((current) => expandGap(current, gap, edge)),
      [],
    ),
    expandFully: useCallback(
      (gap: Gap) => setExpansions((current) => expandGapFully(current, gap)),
      [],
    ),
    wholeFile,
    setWholeFile,
    canExpand: Boolean(headSha),
  };
}
