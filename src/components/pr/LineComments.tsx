import { useEffect, useMemo, useRef, useState } from "react";
import { postPrComment } from "../../lib/pr/api";
import { invalidate, prDetailKey } from "../../lib/pr/cache";
import type { DiffSide, PrFile, PrRef, ReviewThread, SeenCommits } from "../../lib/pr/types";
import { invalidateLastReview } from "../../lib/reviewWorkspaces/sinceReview";
import { CommentComposer, describeLines, needsLineLabel, ThreadView } from "./ThreadView";
import { comparableBody, type ThreadActions, useThreadActions } from "./useThreadActions";

/**
 * The line-comment layer of a file diff: existing review threads, comments
 * posted this session, and the composer, each anchored to a line on one side
 * of the diff — the new file ("RIGHT") or the old one ("LEFT"). Both the
 * unified and the side-by-side renderer drive it, so a comment behaves
 * identically whichever way the reader is looking at the diff.
 */

/** Where a new comment goes: its last line, and its first for a range. */
export interface CommentTarget {
  side: DiffSide;
  line: number;
  startLine?: number;
}

const anchorKey = (side: DiffSide, line: number) => `${side}:${line}`;

/** Groups a file's review threads by the side and line they hang below. */
function threadsByAnchor(threads: ReviewThread[]): Map<string, ReviewThread[]> {
  const map = new Map<string, ReviewThread[]>();
  for (const thread of threads) {
    if (thread.line == null) continue;
    const key = anchorKey(thread.side, thread.line);
    const list = map.get(key);
    if (list) list.push(thread);
    else map.set(key, [thread]);
  }
  return map;
}

/** A comment posted this session, shown optimistically until the server has it. */
interface PostedComment extends CommentTarget {
  /** Survives an entry being dropped from the middle, which an index key can't. */
  id: number;
  body: string;
}

export interface LineComments {
  threadsAt(side: DiffSide, line: number): ReviewThread[] | undefined;
  pending: PostedComment[];
  /** Where the open composer will post, or null when none is open. */
  composer: CommentTarget | null;
  /**
   * Opens the composer on a line. `extend` grows an open composer on the same
   * side to cover every line between it and this one instead.
   */
  openComposer: (side: DiffSide, line: number, extend?: boolean) => void;
  closeComposer: () => void;
  submit: (target: CommentTarget, body: string) => Promise<void>;
  /** Reply and resolve for the threads this file shows. */
  threadActions: ThreadActions;
}

/** The composer's range after a shift-click on `line`. */
function extendTarget(current: CommentTarget, line: number): CommentTarget {
  const first = Math.min(current.startLine ?? current.line, current.line, line);
  const last = Math.max(current.line, line);
  return first < last ? { side: current.side, line: last, startLine: first } : current;
}

/**
 * Owns one file's comment state, shared by whichever renderer is showing it.
 * `seen` is the head the renderer is showing, recorded as where the user
 * reviewed when they comment.
 */
export function useLineComments(
  prRef: PrRef,
  file: PrFile,
  threads: ReviewThread[],
  seen?: SeenCommits,
): LineComments {
  const byAnchor = useMemo(() => threadsByAnchor(threads), [threads]);
  const threadActions = useThreadActions(prRef, threads);
  const [composer, setComposer] = useState<CommentTarget | null>(null);
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
          !byAnchor
            .get(anchorKey(p.side, p.line))
            ?.some((thread) =>
              thread.comments.some((c) => comparableBody(c.body) === comparableBody(p.body)),
            ),
      ),
    [posted, byAnchor],
  );

  // Forget a comment for good once a thread has carried it. Re-deriving the
  // match every render would otherwise resurrect the optimistic card if that
  // thread later stopped carrying the body — an outdated thread loses its line,
  // and `threadsByAnchor` skips it.
  useEffect(() => {
    if (pending.length !== posted.length) setPosted(pending);
  }, [pending, posted.length]);

  const submit = async (target: CommentTarget, body: string) => {
    await postPrComment(
      prRef,
      {
        path: file.filename,
        line: target.line,
        body,
        // Left out when it is the provider's default (the new file, one line).
        ...(target.side === "LEFT" ? { side: "LEFT" as const } : {}),
        ...(target.startLine != null ? { startLine: target.startLine } : {}),
      },
      seen,
    );
    invalidateLastReview(prRef);
    // Read the counter outside the updater, which React may call more than once.
    const id = nextId.current++;
    setPosted((p) => [...p, { ...target, id, body }]);
    setComposer(null);
    // Drop the cached detail so the real thread arrives and supersedes the
    // optimistic copy. This wakes every mounted subscriber, so the refetch can
    // land while this file is still on screen.
    invalidate(prDetailKey(prRef));
  };

  const openComposer = (side: DiffSide, line: number, extend = false) =>
    setComposer((current) =>
      extend && current?.side === side ? extendTarget(current, line) : { side, line },
    );

  return {
    threadsAt: (side, line) => byAnchor.get(anchorKey(side, line)),
    pending,
    composer,
    openComposer,
    closeComposer: () => setComposer(null),
    submit,
    threadActions,
  };
}

/**
 * Whether a line has anything hanging below it. Exported so a renderer that
 * needs a wrapper element around the block (the grid-based side-by-side view)
 * can skip emitting one for the vast majority of lines that have no comments.
 */
export function hasLineComments(
  side: DiffSide,
  line: number | null,
  comments: LineComments,
): boolean {
  if (line == null) return false;
  return (
    comments.threadsAt(side, line) != null ||
    (comments.composer?.side === side && comments.composer.line === line) ||
    comments.pending.some((p) => p.side === side && p.line === line)
  );
}

/**
 * Everything hanging below one diff line on one side: its threads, this
 * session's optimistic comments, and the composer when open. Renders nothing
 * when the line has none of those — an empty container's padding would
 * otherwise show up as a blank gap between consecutive rows.
 */
export function LineCommentBlock({
  side,
  line,
  comments,
}: {
  side: DiffSide;
  line: number | null;
  comments: LineComments;
}) {
  // The null check is redundant with `hasLineComments` but narrows `line` to a
  // number for the composer's submit below.
  if (line == null || !hasLineComments(side, line, comments)) return null;
  const threads = comments.threadsAt(side, line);
  const pending = comments.pending.filter((p) => p.side === side && p.line === line);
  const target =
    comments.composer?.side === side && comments.composer.line === line ? comments.composer : null;

  return (
    <div className="space-y-2 px-3 py-2 font-sans">
      {threads?.map((t, i) => (
        // A provider can leave a thread's id off (Azure does on some threads),
        // and then its position stands in for it.
        <ThreadView key={t.id || `at-${i}`} {...comments.threadActions.viewProps(t)} />
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
      {target && (
        <CommentComposer
          label={needsLineLabel(target) ? `Commenting on ${describeLines(target)}` : undefined}
          onSubmit={(body) => comments.submit(target, body)}
          onCancel={comments.closeComposer}
        />
      )}
    </div>
  );
}

/**
 * Holds a line's "?" and "+" just past the right edge of its gutter, floating
 * over the start of the code. The gutter is three rem wide and the line number
 * owns it — a four-digit number fills it — so keeping the pair out of the
 * gutter's flow is what lets them be sized for a pointer rather than shrinking
 * to a bare glyph. `z-[5]` lifts them over the rows they overlap while staying
 * under the file's sticky header at `z-10`.
 *
 * Hidden until the `group/line` around the line is hovered or holds focus. The
 * reveal sits on this wrapper rather than on each button because a transparent
 * parent hides its children whatever their own opacity, so a tabbed-to button
 * would otherwise stay invisible. `pointer-events-none` while hidden so the
 * cluster doesn't swallow clicks and text selection on the code beneath it.
 *
 * Centred on the line's first visual row rather than on the gutter as a whole:
 * in the split view a long line wraps and makes its row several lines tall, and
 * the buttons belong beside the number they act on. `0.8em` is half a line box
 * at the diff's own leading, so on a single-line row — every row of the unified
 * view — this lands where centring on the gutter did.
 */
export function LineActions({ children }: { children: React.ReactNode }) {
  return (
    <span className="pointer-events-none absolute top-[0.8em] left-full z-[5] flex -translate-y-1/2 items-center gap-1 opacity-0 group-focus-within/line:pointer-events-auto group-focus-within/line:opacity-100 group-hover/line:pointer-events-auto group-hover/line:opacity-100">
      {children}
    </span>
  );
}

/** Shared shape of the per-line action buttons; the glyph's colour is the caller's. */
const ACTION_CLASS =
  "flex size-5 items-center justify-center rounded border border-zinc-700 bg-zinc-900 text-sm leading-none shadow";

/**
 * The hover-revealed "+" that opens the composer on a commentable line. Where
 * the caller supports it (`extendable`), shift-clicking stretches an open
 * composer to cover every line from its own to this one, the same gesture the
 * "?" uses, so a range needs no drag that would fight the browser's text
 * selection.
 */
export function AddCommentButton({
  onClick,
  extendable = false,
}: {
  onClick: (extend: boolean) => void;
  extendable?: boolean;
}) {
  const label = extendable
    ? "Comment on this line — shift-click to extend the open comment to it"
    : "Comment on this line";
  return (
    <button
      type="button"
      onClick={(e) => onClick(e.shiftKey)}
      title={label}
      // The glyph is the label a screen reader would otherwise read out, and
      // "plus" says nothing about what the button does.
      aria-label={label}
      className={`${ACTION_CLASS} text-sky-400 hover:bg-zinc-800 hover:text-sky-300`}
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
      aria-label="Ask about this line — shift-click to extend from the last one"
      className={`${ACTION_CLASS} text-violet-400 hover:bg-zinc-800 hover:text-violet-300`}
    >
      ?
    </button>
  );
}
