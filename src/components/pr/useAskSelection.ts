import { useCallback, useRef } from "react";
import type { ExpandedRow } from "../../lib/pr/expand";
import type { InsightsController, LineSelection } from "./usePrInsights";

/**
 * Turns a click on a line's "?" into the selection a question is asked about.
 *
 * A plain click asks about that line alone; shift-clicking extends from the
 * last line asked about in this file, which is how a reviewer picks out a block
 * without a drag gesture that would fight the browser's own text selection.
 */
export function useAskSelection(
  path: string,
  rows: ExpandedRow[],
  /** Absent where the diff is rendered outside a review (an Omni widget). */
  controller: InsightsController | undefined,
): (line: number, extend: boolean) => void {
  // The far end of a shift-extend. Held in a ref rather than state because
  // nothing renders differently for it — it only shapes the next click.
  const anchor = useRef<number | null>(null);

  return useCallback(
    (line: number, extend: boolean) => {
      if (!controller) return;
      const from = extend && anchor.current != null ? Math.min(anchor.current, line) : line;
      const to = extend && anchor.current != null ? Math.max(anchor.current, line) : line;
      anchor.current = line;

      // The lines as rendered, marker column and all, so the agent reads what
      // the reviewer is looking at rather than a re-fetch that might differ.
      const selection = rows
        .filter(
          (item) =>
            item.kind === "row" &&
            item.row.rightLine != null &&
            item.row.rightLine >= from &&
            item.row.rightLine <= to,
        )
        .map((item) => (item.kind === "row" ? item.row.text : ""))
        .join("\n");

      const target: LineSelection = { path, startLine: from, endLine: to, selection };
      controller.openAsk(target);
    },
    [path, rows, controller],
  );
}
