import { Fragment, useMemo } from "react";
import { pairRows, parsePatch, type SplitCell } from "../../lib/pr/diff";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { rowClass } from "../diff/DiffView";
import {
  AddCommentButton,
  hasLineComments,
  LineCommentBlock,
  useLineComments,
} from "./LineComments";

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
function Gutter({ cell, onComment }: { cell: SplitCell | null; onComment?: () => void }) {
  return (
    <span
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
export default function SplitDiffBody({
  prRef,
  file,
  patch,
  threads,
}: {
  prRef: PrRef;
  file: PrFile;
  patch: string;
  threads: ReviewThread[];
}) {
  const rows = useMemo(() => pairRows(parsePatch(patch)), [patch]);
  const comments = useLineComments(prRef, file, threads);

  return (
    <div className="overflow-x-auto rounded-b-lg bg-zinc-950 font-mono text-xs leading-relaxed">
      <div className="grid w-max min-w-full grid-cols-[3rem_1fr_3rem_1fr]">
        {rows.map((row, i) => {
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
          return (
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
            <Fragment key={i}>
              <Gutter cell={row.left} />
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
    </div>
  );
}
