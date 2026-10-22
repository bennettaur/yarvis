import { useEffect, useRef, useState } from "react";
import type { ReviewThread } from "../../lib/pr/types";
import Markdown from "../Markdown";

/**
 * A text box with submit and cancel, used for a new line comment and for a
 * reply. `onSubmit` rejecting keeps the text and shows the error, so a failed
 * post never loses what the reviewer wrote.
 */
export function CommentComposer({
  onSubmit,
  onCancel,
  label,
  placeholder = "Leave a comment…",
  submitLabel = "Comment",
}: {
  onSubmit: (body: string) => Promise<void>;
  onCancel: () => void;
  /** What the comment is about, e.g. the line range, shown above the box. */
  label?: string;
  placeholder?: string;
  submitLabel?: string;
}) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // The composer only mounts when the user asks for it, so focusing it is
  // expected. Done via a ref rather than the autoFocus attribute (which fires
  // on initial page render and is an accessibility anti-pattern there).
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
      {label && <div className="mb-1 text-xs text-zinc-500">{label}</div>}
      <textarea
        ref={textareaRef}
        value={body}
        placeholder={placeholder}
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
          {busy ? "Posting…" : submitLabel}
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

/** "lines 4–9" for a range, "line 4" otherwise, with the old file named. */
export function describeLines(line: number, startLine?: number, side?: "LEFT" | "RIGHT"): string {
  const lines =
    startLine != null && startLine < line ? `lines ${startLine}–${line}` : `line ${line}`;
  return side === "LEFT" ? `${lines} (old)` : lines;
}

export interface ThreadViewProps {
  thread: ReviewThread;
  /** Replies posted this session that the thread doesn't carry yet. */
  pendingReplies?: string[];
  /**
   * Shows the file and line in the header. Off beside a diff line, where the
   * position is already plain; on in a list of threads away from the code.
   */
  showLocation?: boolean;
  /** Omitted, the thread is read-only: no reply box is offered. */
  onReply?: (body: string) => Promise<void>;
  onResolve?: () => Promise<void>;
  onUnresolve?: () => Promise<void>;
}

/**
 * One review thread: its comments, and the reply and resolve controls the
 * thread allows. Purely presentational — every write goes through the
 * callbacks — so any renderer that can host a React node can show a thread the
 * same way, inline in a diff or in a list.
 */
export function ThreadView({
  thread,
  pendingReplies = [],
  showLocation = false,
  onReply,
  onResolve,
  onUnresolve,
}: ThreadViewProps) {
  const [replying, setReplying] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const toggle = thread.isResolved ? onUnresolve : onResolve;
  const canToggle = thread.canResolve && toggle != null;
  const canReply = thread.canReply && onReply != null;

  const runToggle = async () => {
    if (!toggle) return;
    setBusy(true);
    setError(null);
    try {
      await toggle();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex flex-wrap items-center gap-2 text-xs">
        {showLocation && (
          <span className="font-mono text-zinc-400">
            {thread.path ?? "(general)"}
            {thread.line != null ? `:${thread.line}` : ""}
          </span>
        )}
        {thread.line != null && (thread.startLine != null || thread.side === "LEFT") && (
          <span className="text-zinc-500">
            {describeLines(thread.line, thread.startLine, thread.side)}
          </span>
        )}
        <span className={thread.isResolved ? "text-emerald-500" : "text-amber-500"}>
          {thread.isResolved ? "resolved" : "open"}
        </span>
        {thread.isOutdated && <span className="text-zinc-500">outdated</span>}
      </div>
      <div className="space-y-2">
        {thread.comments.map((cm, j) => (
          // Ids are empty only on data from before ids were carried.
          <div key={cm.id || j}>
            <div className="text-xs font-medium text-zinc-400">{cm.author}</div>
            <Markdown allowImages>{cm.body}</Markdown>
          </div>
        ))}
        {pendingReplies.map((body, j) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: appended in order and only ever dropped once the thread carries them
          <div key={`p-${j}`}>
            <div className="text-xs font-medium text-zinc-500">you · just now</div>
            <div className="text-sm text-zinc-300">{body}</div>
          </div>
        ))}
      </div>
      {error && <p className="mt-2 text-xs text-red-400">{error}</p>}
      {replying && onReply ? (
        <div className="mt-2">
          <CommentComposer
            placeholder="Reply…"
            submitLabel="Reply"
            onSubmit={async (body) => {
              await onReply(body);
              setReplying(false);
            }}
            onCancel={() => setReplying(false)}
          />
        </div>
      ) : (
        (canReply || canToggle) && (
          <div className="mt-2 flex gap-2">
            {canReply && (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Reply
              </button>
            )}
            {canToggle && (
              <button
                type="button"
                onClick={() => void runToggle()}
                disabled={busy}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
              >
                {thread.isResolved ? "Unresolve" : "Resolve"}
              </button>
            )}
          </div>
        )
      )}
    </div>
  );
}
