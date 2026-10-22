import { useEffect, useMemo, useRef, useState } from "react";
import { replyToPrThread, resolvePrThread, unresolvePrThread } from "../../lib/pr/api";
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
  // The resolved state this session last set per thread.
  const [resolved, setResolved] = useState<ReadonlyMap<string, boolean>>(new Map());
  const nextId = useRef(0);

  const pendingReplies = useMemo(
    () =>
      replies.filter(
        (r) =>
          !byId
            .get(r.threadId)
            ?.comments.some((c) => comparableBody(c.body) === comparableBody(r.body)),
      ),
    [replies, byId],
  );

  const pendingResolved = useMemo(() => {
    const out = new Map<string, boolean>();
    for (const [id, value] of resolved) {
      if (byId.get(id)?.isResolved !== value) out.set(id, value);
    }
    return out;
  }, [resolved, byId]);

  // Forget a write for good once the server has agreed with it, so a later
  // change made elsewhere (someone reopening the thread) isn't masked by it.
  useEffect(() => {
    if (pendingReplies.length !== replies.length) setReplies(pendingReplies);
  }, [pendingReplies, replies.length]);
  useEffect(() => {
    if (pendingResolved.size !== resolved.size) setResolved(pendingResolved);
  }, [pendingResolved, resolved.size]);

  const reply = async (thread: ReviewThread, body: string) => {
    await replyToPrThread(prRef, thread, body);
    const id = nextId.current++;
    setReplies((r) => [...r, { id, threadId: thread.id, body }]);
    invalidate(prDetailKey(prRef));
  };

  const setThreadResolved = async (thread: ReviewThread, value: boolean) => {
    await (value ? resolvePrThread : unresolvePrThread)(prRef, thread.id);
    setResolved((m) => new Map(m).set(thread.id, value));
    invalidate(prDetailKey(prRef));
  };

  return {
    viewProps(thread) {
      const override = pendingResolved.get(thread.id);
      return {
        thread: override === undefined ? thread : { ...thread, isResolved: override },
        pendingReplies: pendingReplies.filter((r) => r.threadId === thread.id).map((r) => r.body),
        onReply: (body) => reply(thread, body),
        onResolve: () => setThreadResolved(thread, true),
        onUnresolve: () => setThreadResolved(thread, false),
      };
    },
  };
}
