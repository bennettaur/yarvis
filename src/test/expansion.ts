import type { FileExpansion } from "../components/pr/useFileExpansion";
import { parsePatch } from "../lib/pr/diff";
import { type Expansions, expandRows } from "../lib/pr/expand";

/**
 * Builds the expansion a diff renderer consumes, without the hook's fetching.
 * The row splicing is exercised directly in `expand.test.ts`; the renderers only
 * need a fixed set of rows to draw, so their tests stay about markup.
 */
export function fakeExpansion(
  patch: string,
  options: {
    fileLines?: string[];
    expansions?: Expansions;
    wholeFile?: boolean;
    onExpand?: FileExpansion["expand"];
  } = {},
): FileExpansion {
  const fileLines = options.fileLines ?? [];
  return {
    rows: expandRows(parsePatch(patch), fileLines, options.expansions ?? new Map()),
    totalLines: fileLines.length,
    loading: false,
    error: null,
    expand: options.onExpand ?? (() => {}),
    expandFully: () => {},
    wholeFile: options.wholeFile ?? false,
    setWholeFile: () => {},
    canExpand: true,
  };
}
