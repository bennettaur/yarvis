import { useEffect, useMemo, useRef, useState } from "react";
import { parsePatch } from "../../lib/pr/diff";
import { highlightDiff, rowHtml } from "../../lib/pr/highlight";
import type { CreateReviewCommentInput, ReviewComment } from "../../lib/workspaceReview";
import { CodeText, rowClass } from "../diff/DiffRow";
import { AddCommentButton, LineActions } from "../pr/LineComments";
import ReviewCommentCard from "./ReviewCommentCard";

/**
 * A workspace file's unified diff with the self-review layer on top: existing
 * comments hang under the lines they were left on, and dragging down the line
 * gutter picks out a range to comment on. Comments anchor to the right-hand
 * (new file) line, the same side a PR review anchors to, so a note written here
 * describes the code as it will land. The code is syntax-colored from the file's
 * path, as the PR review's diffs are.
 */

/** An inclusive run of right-hand (new file) line numbers. */
interface LineRange {
  start: number;
  end: number;
}

/** The two ends of a drag as an ordered range, so dragging up reads the same
 *  as dragging down. */
const span = (a: number, b: number): LineRange => ({
  start: Math.min(a, b),
  end: Math.max(a, b),
});

const covers = (range: LineRange | null, line: number | null): boolean =>
  range !== null && line !== null && line >= range.start && line <= range.end;

/** Inline composer for a new comment, mirroring the PR review's. */
function Composer({
  range,
  onSubmit,
  onCancel,
}: {
  range: LineRange;
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
  const highlight = useMemo(() => highlightDiff(rows, path), [rows, path]);
  const byLine = useMemo(() => commentsByLine(comments), [comments]);
  const [draft, setDraft] = useState<LineRange | null>(null);
  /** The gutter lines a drag in progress covers; null when none is. */
  const [dragging, setDragging] = useState<LineRange | null>(null);
  /** Where the drag started and where it currently reaches. Held in a ref
   *  because the window listener below is registered once per drag and would
   *  otherwise close over the values as they were at mousedown. */
  const drag = useRef<{ anchor: number; cursor: number } | null>(null);

  // The release is watched on the window, since a drag can end anywhere —
  // including outside the diff. Registered from the mousedown handler rather
  // than an effect: an effect runs after paint, so a click quicker than that
  // (tap-to-click routinely is) would release before anything was listening and
  // leave the drag stuck to the pointer.
  const startDrag = (line: number) => {
    drag.current = { anchor: line, cursor: line };
    setDragging({ start: line, end: line });
    window.addEventListener(
      "mouseup",
      () => {
        const range = drag.current;
        drag.current = null;
        setDragging(null);
        if (!range) return;
        // A drag that ends where an unsaved composer is open would throw away
        // what the reviewer has typed, so the existing draft wins.
        setDraft((open) => open ?? span(range.anchor, range.cursor));
      },
      { once: true },
    );
  };

  const extendDrag = (line: number) => {
    if (!drag.current) return;
    drag.current = { ...drag.current, cursor: line };
    setDragging(span(drag.current.anchor, line));
  };

  // Cleared when the diff unmounts mid-drag, so a release that arrives after
  // has no range left to act on.
  useEffect(
    () => () => {
      drag.current = null;
    },
    [],
  );

  if (patch.trim().length === 0) {
    return <p className="p-3 text-xs text-zinc-600">No textual diff (binary or unchanged).</p>;
  }

  const save = async (range: LineRange, body: string) => {
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
        const selected = covers(dragging, line) || covers(draft, line);
        const lineComments = line === null ? undefined : byLine.get(line);
        const composing = draft !== null && line === draft.end;
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: rows are a stable render of an immutable patch
          <div key={i}>
            <div
              className={`group/line flex ${rowClass(row.kind)} ${selected ? "bg-sky-900/40" : ""}`}
            >
              {/* The gutter is the drag handle. `preventDefault` on its
                  mousedown is what stops the gesture from also starting a text
                  selection that would run into the code beside it — `select-none`
                  only governs the gutter's own text. */}
              {/* biome-ignore lint/a11y/noStaticElementInteractions: a pointer-only shortcut for the "+" button it contains, which is the keyboard and screen-reader path */}
              <span
                className={`relative flex w-12 shrink-0 select-none items-center justify-end pr-2 text-zinc-600 ${
                  line === null ? "" : "cursor-ns-resize"
                }`}
                onMouseDown={
                  line === null
                    ? undefined
                    : (e) => {
                        e.preventDefault();
                        startDrag(line);
                      }
                }
                onMouseEnter={line === null ? undefined : () => extendDrag(line)}
              >
                {line !== null && (
                  <LineActions>
                    <AddCommentButton onClick={() => setDraft({ start: line, end: line })} />
                  </LineActions>
                )}
                <span>{line ?? ""}</span>
              </span>
              <CodeText html={rowHtml(row, highlight)} text={row.text} />
            </div>
            {(lineComments || composing) && (
              <div className="space-y-2 px-3 py-2 font-sans">
                {lineComments?.map((comment) => (
                  <ReviewCommentCard
                    key={comment.id}
                    comment={comment}
                    onToggleResolved={() => onToggleResolved(comment)}
                    onDelete={() => onDelete(comment)}
                  />
                ))}
                {draft && composing && (
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
