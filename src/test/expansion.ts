import type { FileExpansion } from "../components/pr/useFileExpansion";
import { parsePatch } from "../lib/pr/diff";
import { type Expansions, expandAllGaps, expandRows } from "../lib/pr/expand";

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
  const rows = parsePatch(patch);
  // Whole-file mode is every gap opened at once, which is how the hook derives
  // it too — a caller asking for it shouldn't have to hand-build the expansions.
  const expansions =
    options.expansions ??
    (options.wholeFile && fileLines.length > 0
      ? expandAllGaps(rows, fileLines.length)
      : (new Map() as Expansions));
  return {
    rows: expandRows(rows, fileLines, expansions),
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
