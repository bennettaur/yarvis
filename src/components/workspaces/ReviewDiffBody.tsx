import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../../lib/pr/diff";
import type { CreateReviewCommentInput, ReviewComment } from "../../lib/workspaceReview";
import { rowClass } from "../diff/rowStyles";
import { AddCommentButton, LineActions } from "../pr/LineComments";
import ReviewCommentCard from "./ReviewCommentCard";

/**
 * A workspace file's unified diff with the self-review layer on top: existing
 * comments hang under the lines they were left on, and dragging down the line
 * gutter picks out a range to comment on. Comments anchor to the right-hand
 * (new file) line, the same side a PR review anchors to, so a note written here
 * describes the code as it will land.
 */

/** The line range a composer is open for. */
interface Draft {
  start: number;
  end: number;
}

/** Inline composer for a new comment, mirroring the PR review's. */
function Composer({
  range,
  onSubmit,
  onCancel,
}: {
  range: Draft;
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The composer only mounts once the user has asked for it, so taking focus is
  // expected. Via a ref rather than `autoFocus`, matching the PR composer.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const submit = async () => {
    if (!body.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit(body.trim());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div className="border-l-2 border-sky-700 bg-zinc-900 p-2 font-sans">
      <div className="mb-1 text-xs text-zinc-500">
        {range.start === range.end ? `Line ${range.start}` : `Lines ${range.start}–${range.end}`}
      </div>
      <textarea
        ref={textareaRef}
        value={body}
        placeholder="Note for yourself (or for Claude)…"
        onChange={(e) => setBody(e.target.value)}
        className="h-20 w-full rounded-md border border-zinc-700 bg-zinc-800 p-2 text-sm text-zinc-100"
      />
      {error && <p className="mt-1 text-xs text-red-400">{error}</p>}
      <div className="mt-1 flex gap-2">
        <button
          type="button"
          onClick={() => void submit()}
          disabled={busy || !body.trim()}
          className="rounded-md bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save comment"}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-md border border-zinc-700 px-3 py-1 text-xs hover:bg-zinc-800"
        >
          Cancel
        </button>
      </div>
    </div>
  );
}

/**
 * Groups comments by the line they hang under — the last line of their range,
 * so a multi-line note appears at the bottom of what it covers, the way GitHub
 * places one.
 */
function commentsByLine(comments: ReviewComment[]): Map<number, ReviewComment[]> {
  const map = new Map<number, ReviewComment[]>();
  for (const comment of comments) {
    const list = map.get(comment.endLine);
    if (list) list.push(comment);
    else map.set(comment.endLine, [comment]);
  }
  return map;
}

export default function ReviewDiffBody({
  patch,
  path,
  workspaceRepoId,
  comments,
  onAdd,
  onToggleResolved,
  onDelete,
}: {
  patch: string;
  path: string;
  workspaceRepoId: string;
  /** This file's comments only; the caller filters by path. */
  comments: ReviewComment[];
  onAdd: (input: CreateReviewCommentInput) => Promise<void>;
  onToggleResolved: (comment: ReviewComment) => void;
  onDelete: (comment: ReviewComment) => void;
}) {
  const rows = useMemo(() => parsePatch(patch), [patch]);
  const byLine = useMemo(() => commentsByLine(comments), [comments]);
  const [draft, setDraft] = useState<Draft | null>(null);
  /** Where a gutter drag started; null when no drag is in progress. */
  const [dragAnchor, setDragAnchor] = useState<number | null>(null);
  /** The line the drag currently reaches, so the range highlights as it grows. */
  const [dragLine, setDragLine] = useState<number | null>(null);

  // The drag ends wherever the pointer is released, including outside the diff,
  // so the release is watched on the window rather than on a row.
  useEffect(() => {
    if (dragAnchor === null) return;
    const finish = () => {
      const end = dragLine ?? dragAnchor;
      setDraft({ start: Math.min(dragAnchor, end), end: Math.max(dragAnchor, end) });
      setDragAnchor(null);
      setDragLine(null);
    };
    window.addEventListener("mouseup", finish);
    return () => window.removeEventListener("mouseup", finish);
  }, [dragAnchor, dragLine]);

  if (patch.trim().length === 0) {
    return <p className="p-3 text-xs text-zinc-600">No textual diff (binary or unchanged).</p>;
  }

  const dragging =
    dragAnchor === null
      ? null
      : {
          start: Math.min(dragAnchor, dragLine ?? dragAnchor),
          end: Math.max(dragAnchor, dragLine ?? dragAnchor),
        };
  const inRange = (line: number | null, range: Draft | null): boolean =>
    line !== null && range !== null && line >= range.start && line <= range.end;

  const save = async (range: Draft, body: string) => {
    await onAdd({
      workspaceRepoId,
      path,
      startLine: range.start,
      endLine: range.end,
      body,
    });
    setDraft(null);
  };

  return (
    <div className="h-full overflow-auto bg-zinc-950 font-mono text-xs leading-relaxed">
      {rows.map((row, i) => {
        const line = row.rightLine;
        const selected = inRange(line, dragging) || inRange(line, draft);
        const lineComments = line === null ? undefined : byLine.get(line);
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
          <div key={i}>
            <div
              className={`group/line flex ${rowClass(row.kind)} ${selected ? "bg-sky-900/40" : ""}`}
            >
              {/* The gutter is the drag handle: `select-none` on it already
                  stops a drag here from turning into a text selection, so the
                  gesture doesn't fight the browser over the code beside it. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only shortcut for the "+" button it contains, which is the keyboard and screen-reader path */}
              <span
                className={`relative flex w-12 shrink-0 select-none items-center justify-end pr-2 text-zinc-600 ${
                  line === null ? "" : "cursor-ns-resize"
                }`}
                onMouseDown={
                  line === null
                    ? undefined
                    : () => {
                        setDragAnchor(line);
                        setDragLine(line);
                      }
                }
                onMouseEnter={
                  line === null || dragAnchor === null ? undefined : () => setDragLine(line)
                }
              >
                {line !== null && (
                  <LineActions>
                    <AddCommentButton onClick={() => setDraft({ start: line, end: line })} />
                  </LineActions>
                )}
                <span>{line ?? ""}</span>
              </span>
              <span className="whitespace-pre">{row.text || " "}</span>
            </div>
            {(lineComments || (draft && line === draft.end)) && (
              <div className="space-y-2 px-3 py-2 font-sans">
                {lineComments?.map((comment) => (
                  <ReviewCommentCard
                    key={comment.id}
                    comment={comment}
                    onToggleResolved={() => onToggleResolved(comment)}
                    onDelete={() => onDelete(comment)}
                  />
                ))}
                {draft && line === draft.end && (
                  <Composer
                    range={draft}
                    onSubmit={(body) => save(draft, body)}
                    onCancel={() => setDraft(null)}
                  />
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
