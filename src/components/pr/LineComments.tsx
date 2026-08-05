import { useEffect, useMemo, useRef, useState } from "react";
import { postPrComment } from "../../lib/pr/api";
import { invalidate, prDetailKey } from "../../lib/pr/cache";
import type { PrFile, PrRef, ReviewThread } from "../../lib/pr/types";
import { ThreadCard } from "./PrDescription";

/**
 * The line-comment layer of a file diff: existing review threads, comments
 * posted this session, and the composer, all anchored to a right-side line
 * number. Both the unified and the side-by-side renderer drive it, so a comment
 * behaves identically whichever way the reader is looking at the diff.
 */

/** Inline composer for a new line comment. */
function CommentComposer({
  onSubmit,
  onCancel,
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The composer only mounts when the user clicks a line's "+", so focusing it
  // is expected. Done via a ref rather than the autoFocus attribute (which
  // fires on initial page render and is an accessibility anti-pattern there).
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
    <div className="border-l-2 border-sky-700 bg-zinc-900 p-2">
      <textarea
        ref={textareaRef}
        value={body}
        placeholder="Leave a comment…"
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
          {busy ? "Posting…" : "Comment"}
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

/** Groups a file's review threads by their right-side line number. */
function threadsByLine(threads: ReviewThread[]): Map<number, ReviewThread[]> {
  const map = new Map<number, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.line == null) continue;
    const list = map.get(thread.line);
    if (list) list.push(thread);
    else map.set(thread.line, [thread]);
  }
  return map;
}

/** A comment posted this session, shown optimistically until the server has it. */
interface PostedComment {
  /** Survives an entry being dropped from the middle, which an index key can't. */
  id: number;
  line: number;
  body: string;
}

export interface LineComments {
  byLine: Map<number, ReviewThread[]>;
  pending: PostedComment[];
  activeLine: number | null;
  openComposer: (line: number) => void;
  closeComposer: () => void;
  submit: (line: number, body: string) => Promise<void>;
}

/**
 * Comparable form of a comment body. A provider echoes a body back with its own
 * line endings, and the composer has already trimmed what it sent, so neither
 * difference should count as a mismatch below.
 */
const comparable = (body: string) => body.replace(/\r\n/g, "\n").trim();

/** Owns one file's comment state, shared by whichever renderer is showing it. */
export function useLineComments(prRef: PrRef, file: PrFile, threads: ReviewThread[]): LineComments {
  const byLine = useMemo(() => threadsByLine(threads), [threads]);
  const [activeLine, setActiveLine] = useState<number | null>(null);
  // Every comment posted this session; `pending` below narrows it to the ones
  // the server hasn't echoed back yet.
  const [posted, setPosted] = useState<PostedComment[]>([]);
  const nextId = useRef(0);

  // A posted comment stops being optimistic the moment the refetched threads
  // carry it. Matching on the body rather than clearing the whole list on any
  // thread change keeps the comment on screen when the provider hasn't caught
  // up yet — a read-after-write that misses it would otherwise blink it away.
  const pending = useMemo(
    () =>
      posted.filter(
        (p) =>
          !byLine
            .get(p.line)
            ?.some((thread) =>
              thread.comments.some((c) => comparable(c.body) === comparable(p.body)),
            ),
      ),
    [posted, byLine],
  );

  // Forget a comment for good once a thread has carried it. Re-deriving the
  // match every render would otherwise resurrect the optimistic card if that
  // thread later stopped carrying the body — an outdated thread loses its line,
  // and `threadsByLine` skips it.
  useEffect(() => {
    if (pending.length !== posted.length) setPosted(pending);
  }, [pending, posted.length]);

  const submit = async (line: number, body: string) => {
    await postPrComment(prRef, { path: file.filename, line, body });
    // Read the counter outside the updater, which React may call more than once.
    const id = nextId.current++;
    setPosted((p) => [...p, { id, line, body }]);
    setActiveLine(null);
    // Drop the cached detail so the real thread arrives and supersedes the
    // optimistic copy. This wakes every mounted subscriber, so the refetch can
    // land while this file is still on screen.
    invalidate(prDetailKey(prRef));
  };

  return {
    byLine,
    pending,
    activeLine,
    openComposer: setActiveLine,
    closeComposer: () => setActiveLine(null),
    submit,
  };
}

/**
 * Whether a line has anything hanging below it. Exported so a renderer that
 * needs a wrapper element around the block (the grid-based side-by-side view)
 * can skip emitting one for the vast majority of lines that have no comments.
 */
export function hasLineComments(line: number | null, comments: LineComments): boolean {
  if (line == null) return false;
  return (
    comments.byLine.has(line) ||
    comments.activeLine === line ||
    comments.pending.some((p) => p.line === line)
  );
}

/**
 * Everything hanging below one diff line: its threads, this session's optimistic
 * comments, and the composer when open. Renders nothing when the line has none
 * of those — an empty container's padding would otherwise show up as a blank gap
 * between consecutive rows.
 */
export function LineCommentBlock({
  line,
  comments,
}: {
  line: number | null;
  comments: LineComments;
}) {
  // The null check is redundant with `hasLineComments` but narrows `line` to a
  // number for the composer's submit below.
  if (line == null || !hasLineComments(line, comments)) return null;
  const threads = comments.byLine.get(line);
  const pending = comments.pending.filter((p) => p.line === line);
  const composing = comments.activeLine === line;

  return (
    <div className="space-y-2 px-3 py-2 font-sans">
      {threads?.map((t, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: threads render an immutable server snapshot
        <ThreadCard key={`t-${i}`} thread={t} />
      ))}
      {pending.map((p) => (
        <div
          key={`p-${p.id}`}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-300"
        >
          <div className="mb-1 text-xs font-medium text-zinc-500">you · just now</div>
          {p.body}
        </div>
      ))}
      {composing && (
        <CommentComposer
          onSubmit={(body) => comments.submit(line, body)}
          onCancel={comments.closeComposer}
        />
      )}
    </div>
  );
}

/** The hover-revealed "+" that opens the composer on a commentable line. */
export function AddCommentButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title="Comment on this line"
      className="text-sky-400 opacity-0 hover:text-sky-300 focus-visible:opacity-100 group-hover:opacity-100"
    >
      +
    </button>
  );
}

/**
 * The hover-revealed "?" that asks about a line. Shift-clicking extends the
 * question to cover everything from the last line asked about in this file, so
 * a reviewer can ask about a block without a drag gesture that would fight the
 * browser's own text selection.
 */
export function AskAboutLineButton({ onClick }: { onClick: (extend: boolean) => void }) {
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.shiftKey)}
      title="Ask about this line — shift-click to extend from the last one"
      className="text-violet-400 opacity-0 hover:text-violet-300 focus-visible:opacity-100 group-hover:opacity-100"
    >
      ?
    </button>
  );
}
