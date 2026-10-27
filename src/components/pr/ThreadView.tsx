import { useEffect, useRef, useState } from "react";
import type { DiffSide, ReviewThread } from "../../lib/pr/types";
import { openExternal } from "../../lib/url";
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

/** Where a comment sits: its last line on `side`, and its first for a range. */
export interface LineAnchor {
  line: number;
  side: DiffSide;
  startLine?: number;
  /** Defaults to `side`. */
  startSide?: DiffSide;
}

const fileName = (side: DiffSide) => (side === "LEFT" ? "old" : "new");

/**
 * "lines 4–9" for a range, "line 4" otherwise, with the old file named. A
 * range that starts in one file and ends in the other names both, since its
 * two numbers count lines in different files.
 */
export function describeLines({ line, side, startLine, startSide = side }: LineAnchor): string {
  if (startLine != null && startSide !== side) {
    return `${fileName(startSide)} line ${startLine} to ${fileName(side)} line ${line}`;
  }
  const lines =
    startLine != null && startLine < line ? `lines ${startLine}–${line}` : `line ${line}`;
  return side === "LEFT" ? `${lines} (old)` : lines;
}

/**
 * Whether a comment's position is worth spelling out beside it: a plain
 * comment on one line of the new file isn't, since the line it hangs under
 * says as much.
 */
export function needsLineLabel({ side, startLine }: Pick<LineAnchor, "side" | "startLine">) {
  return startLine != null || side === "LEFT";
}

/** "GitHub" or "Azure DevOps" for a link into either, for the link's label. */
function providerName(url: string): string | null {
  try {
    const host = new URL(url).hostname;
    if (host === "github.com" || host.endsWith(".github.com")) return "GitHub";
    if (host === "dev.azure.com" || host.endsWith(".visualstudio.com")) return "Azure DevOps";
  } catch {
    // Not a URL: no label, and no link.
  }
  return null;
}

/** A reply posted this session that the thread doesn't carry yet. */
export interface PendingReply {
  id: number;
  body: string;
}

export interface ThreadViewProps {
  thread: ReviewThread;
  pendingReplies?: PendingReply[];
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
  const [isTogglingResolved, setIsTogglingResolved] = useState(false);
  const [toggleError, setToggleError] = useState<string | null>(null);

  const toggleResolved = thread.isResolved ? onUnresolve : onResolve;
  const mayToggleResolved = thread.isResolved ? thread.canUnresolve : thread.canResolve;
  const showToggleResolved = mayToggleResolved && toggleResolved != null;
  const showReply = thread.canReply && onReply != null;
  const url = thread.comments[0]?.url;
  const urlProvider = url ? providerName(url) : null;

  const runToggleResolved = async () => {
    if (!toggleResolved) return;
    setIsTogglingResolved(true);
    setToggleError(null);
    try {
      await toggleResolved();
    } catch (e) {
      setToggleError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsTogglingResolved(false);
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
        {thread.line != null && needsLineLabel(thread) && (
          <span className="text-zinc-500">{describeLines({ ...thread, line: thread.line })}</span>
        )}
        <span className={thread.isResolved ? "text-emerald-500" : "text-amber-500"}>
          {thread.isResolved ? "resolved" : "open"}
        </span>
        {thread.isOutdated && <span className="text-zinc-500">outdated</span>}
        {url && urlProvider && (
          <button
            type="button"
            onClick={() => openExternal(url)}
            className="ml-auto text-zinc-500 hover:text-zinc-300"
          >
            open on {urlProvider} ↗
          </button>
        )}
      </div>
      <div className="space-y-2">
        {thread.comments.map((cm, j) => (
          // A provider can leave a comment's id off (Azure does on some
          // threads), and then its position stands in for it.
          <div key={cm.id || `at-${j}`}>
            <div className="text-xs font-medium text-zinc-400">{cm.author}</div>
            <Markdown allowImages>{cm.body}</Markdown>
          </div>
        ))}
        {pendingReplies.map((reply) => (
          <div key={`pending-${reply.id}`}>
            <div className="text-xs font-medium text-zinc-500">you · just now</div>
            <div className="text-sm text-zinc-300">{reply.body}</div>
          </div>
        ))}
      </div>
      {toggleError && <p className="mt-2 text-xs text-red-400">{toggleError}</p>}
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
        (showReply || showToggleResolved) && (
          <div className="mt-2 flex gap-2">
            {showReply && (
              <button
                type="button"
                onClick={() => setReplying(true)}
                className="rounded-md border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Reply
              </button>
            )}
            {showToggleResolved && (
              <button
                type="button"
                onClick={() => void runToggleResolved()}
                disabled={isTogglingResolved}
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
