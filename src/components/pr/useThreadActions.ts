import { useEffect, useMemo, useRef, useState } from "react";
import { replyToPrThread, setPrThreadResolved } from "../../lib/pr/api";
import { invalidate, prDetailKey } from "../../lib/pr/cache";
import type { PrRef, ReviewThread } from "../../lib/pr/types";
import type { ThreadViewProps } from "./ThreadView";

/**
 * Comparable form of a comment body. A provider echoes a body back with its own
 * line endings, and the composer has already trimmed what it sent, so neither
 * difference should count as a mismatch.
 */
export const comparableBody = (body: string) => body.replace(/\r\n/g, "\n").trim();

/** A reply posted this session, shown until the refetched thread carries it. */
interface PostedReply {
  id: number;
  threadId: string;
  body: string;
  /**
   * How many comments the thread had when the reply was posted. Only a comment
   * after those can be this reply: a short reply ("done", "+1") often repeats
   * an earlier comment word for word.
   */
  afterCount: number;
}

type ThreadsById = ReadonlyMap<string, ReviewThread>;

function replyIsPending(reply: PostedReply, byId: ThreadsById): boolean {
  const thread = byId.get(reply.threadId);
  if (!thread) return true;
  const body = comparableBody(reply.body);
  return !thread.comments.slice(reply.afterCount).some((c) => comparableBody(c.body) === body);
}

/** The overrides the server hasn't agreed with yet. */
function pendingOverrides(
  overrides: ReadonlyMap<string, boolean>,
  byId: ThreadsById,
): ReadonlyMap<string, boolean> {
  const out = new Map<string, boolean>();
  for (const [id, value] of overrides) {
    if (byId.get(id)?.isResolved !== value) out.set(id, value);
  }
  return out;
}

export interface ThreadActions {
  /**
   * Everything a `ThreadView` needs to show `thread` with this session's
   * writes applied and its controls wired to the provider.
   */
  viewProps(thread: ReviewThread): ThreadViewProps;
}

/**
 * Replies and resolve/unresolve for a PR's review threads, with the same
 * optimism posting a new comment has: a write that succeeded shows at once and
 * stays shown until the refetched threads agree with it, rather than blinking
 * away on a read that hasn't caught up.
 */
export function useThreadActions(prRef: PrRef, threads: ReviewThread[]): ThreadActions {
  const byId = useMemo(() => new Map(threads.map((t) => [t.id, t])), [threads]);
  const [replies, setReplies] = useState<PostedReply[]>([]);
  // The resolved state this session last set, per thread id.
  const [resolvedOverrides, setResolvedOverrides] = useState<ReadonlyMap<string, boolean>>(
    new Map(),
  );
  const nextId = useRef(0);

  const pendingReplies = useMemo(
    () => replies.filter((r) => replyIsPending(r, byId)),
    [replies, byId],
  );
  const pendingResolved = useMemo(
    () => pendingOverrides(resolvedOverrides, byId),
    [resolvedOverrides, byId],
  );

  // Forget a write for good once the server has agreed with it, so a later
  // change made elsewhere (someone reopening the thread) isn't masked by it.
  useEffect(() => {
    setReplies((current) => {
      const next = current.filter((r) => replyIsPending(r, byId));
      return next.length === current.length ? current : next;
    });
    setResolvedOverrides((current) => {
      const next = pendingOverrides(current, byId);
      return next.size === current.size ? current : next;
    });
  }, [byId]);

  const reply = async (thread: ReviewThread, body: string) => {
    await replyToPrThread(prRef, thread, body);
    // Read the counter outside the updater, which React may call more than once.
    const id = nextId.current++;
    const afterCount = thread.comments.length;
    setReplies((r) => [...r, { id, threadId: thread.id, body, afterCount }]);
    invalidate(prDetailKey(prRef));
  };

  const setThreadResolved = async (thread: ReviewThread, resolved: boolean) => {
    await setPrThreadResolved(prRef, thread.id, resolved);
    setResolvedOverrides((m) => new Map(m).set(thread.id, resolved));
    invalidate(prDetailKey(prRef));
  };

  return {
    viewProps(thread) {
      const override = pendingResolved.get(thread.id);
      return {
        // Only the state flips; which control shows next still follows the
        // thread's own permissions for that state.
        thread: override === undefined ? thread : { ...thread, isResolved: override },
        pendingReplies: pendingReplies
          .filter((r) => r.threadId === thread.id)
          .map(({ id, body }) => ({ id, body })),
        onReply: (body) => reply(thread, body),
        onResolve: () => setThreadResolved(thread, true),
        onUnresolve: () => setThreadResolved(thread, false),
      };
    },
  };
}
