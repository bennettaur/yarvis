import { Fragment, useMemo } from "react";
import { type DiffRow, pairRows, type SplitCell, type SplitRow } from "../../lib/pr/diff";
import type { Gap } from "../../lib/pr/expand";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { rowClass } from "../diff/DiffView";
import ChangeMinimap from "./ChangeMinimap";
import GapMarker from "./GapMarker";
import {
  AddCommentButton,
  hasLineComments,
  LineCommentBlock,
  useLineComments,
} from "./LineComments";
import { FOCUS_ATTR, FOCUS_STYLE } from "./shared";
import type { FileExpansion } from "./useFileExpansion";

/**
 * Background for the blank half of an uneven change — three deletions across
 * from one addition leaves two right-hand cells with nothing in them. Muted
 * rather than transparent so the gap reads as "no counterpart here" instead of
 * as an unchanged empty line.
 */
const FILLER_CLASS = "bg-zinc-900/40";

/**
 * One side's line-number gutter. `group` sits here rather than on a row wrapper
 * because in a CSS grid every cell is a sibling — there is no per-row element to
 * hang a hover state on — so the "+" reveals when the reader moves onto the
 * gutter beside the line they want to comment on.
 */
function Gutter({
  cell,
  onComment,
  style,
  focusAnchor,
}: {
  cell: SplitCell | null;
  onComment?: () => void;
  style?: React.CSSProperties;
  /** Marks the first row of a focused range so a scroll can find it. */
  focusAnchor?: boolean;
}) {
  return (
    <span
      style={style}
      {...(focusAnchor ? { [FOCUS_ATTR]: "true" } : {})}
      className={`group flex w-12 shrink-0 select-none items-center justify-end gap-1 pr-2 text-zinc-600 ${
        cell ? rowClass(cell.kind) : FILLER_CLASS
      }`}
    >
      {onComment && <AddCommentButton onClick={onComment} />}
      <span>{cell?.line ?? ""}</span>
    </span>
  );
}

function Code({ cell }: { cell: SplitCell | null }) {
  return (
    <span className={`whitespace-pre pr-4 ${cell ? rowClass(cell.kind) : FILLER_CLASS}`}>
      {cell ? cell.text || " " : " "}
    </span>
  );
}

/**
 * A file's diff with the old and new file side by side, the nth deletion across
 * from the nth addition (see `pairRows`).
 *
 * Laid out as one CSS grid rather than two scrolling columns: comment blocks are
 * full-width and their height varies, so independent columns would drift out of
 * vertical alignment the moment a thread appeared. `w-max` lets the two code
 * tracks size to the widest line and stay equal to each other, so the whole
 * diff scrolls horizontally as a single unit with both sides in step.
 *
 * Comments anchor to the right (new file) line, matching what both providers
 * accept — so the composer is only offered on the right gutter.
 */
/** A gap marker carried through pairing, to be drawn across both columns. */
type SplitOrGap = SplitRow | { kind: "gap"; gap: Gap; hidden: number };

/**
 * Pairs each stretch of rows on its own, so a run of changes is never matched
 * up across a stretch of code that isn't being shown.
 */
function pairAroundGaps(rows: FileExpansion["rows"]): SplitOrGap[] {
  const out: SplitOrGap[] = [];
  let buffer: DiffRow[] = [];
  const flush = () => {
    if (buffer.length === 0) return;
    out.push(...pairRows(buffer));
    buffer = [];
  };
  for (const item of rows) {
    if (item.kind === "gap") {
      flush();
      out.push(item);
    } else {
      buffer.push(item.row);
    }
  }
  flush();
  return out;
}

export default function SplitDiffBody({
  prRef,
  file,
  threads,
  expansion,
  highlight,
}: {
  prRef: PrRef;
  file: PrFile;
  threads: ReviewThread[];
  expansion: FileExpansion;
  /** Lines a guided review is pointing at, marked down the left edge. */
  highlight?: { start: number; end: number } | null;
}) {
  const rows = useMemo(() => pairAroundGaps(expansion.rows), [expansion.rows]);
  const comments = useLineComments(prRef, file, threads);

  return (
    <div className="relative overflow-x-auto rounded-b-lg bg-zinc-950 font-mono text-xs leading-relaxed">
      <div className="grid w-max min-w-full grid-cols-[3rem_1fr_3rem_1fr]">
        {rows.map((row, i) => {
          if (row.kind === "gap") {
            return (
              <GapMarker
                key={`gap-${row.gap.index}`}
                gap={row.gap}
                hidden={row.hidden}
                onExpand={expansion.expand}
                onExpandFully={expansion.expandFully}
                className="col-span-4"
              />
            );
          }
          if (row.kind === "hunk" || row.kind === "meta") {
            return (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
                key={i}
                className={`col-span-4 whitespace-pre px-2 ${rowClass(row.kind)}`}
              >
                {row.text}
              </span>
            );
          }
          const rightLine = row.right?.line ?? null;
          const marked =
            highlight != null &&
            rightLine != null &&
            rightLine >= highlight.start &&
            rightLine <= highlight.end;
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
            <Fragment key={i}>
              {/* The marker rides the leftmost cell of the row. Grid cells are
                  siblings with no row element between them, so there is nothing
                  spanning the row to hang it on. */}
              <Gutter
                cell={row.left}
                style={marked ? FOCUS_STYLE : undefined}
                focusAnchor={marked && rightLine === highlight.start}
              />
              <Code cell={row.left} />
              <Gutter
                cell={row.right}
                onComment={rightLine != null ? () => comments.openComposer(rightLine) : undefined}
              />
              <Code cell={row.right} />
              {/* Only emitted for lines that actually have something below
                  them: a wrapper per line would double the grid's item count
                  on a long file. Capped in width so a long comment can't widen
                  the grid and force the code columns to scroll sideways — the
                  cap sits under the pane's own width, so in practice it never
                  binds before `min-w-full` does. */}
              {hasLineComments(rightLine, comments) && (
                <div className="col-span-4 min-w-0 max-w-2xl">
                  <LineCommentBlock line={rightLine} comments={comments} />
                </div>
              )}
            </Fragment>
          );
        })}
      </div>
      {expansion.wholeFile && (
        <ChangeMinimap rows={expansion.rows} totalLines={expansion.totalLines} />
      )}
    </div>
  );
}
