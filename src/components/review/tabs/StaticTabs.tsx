import { type ReactNode, useMemo, useState } from "react";
import { usePrDetail } from "../../../lib/pr/cache";
import type { ReviewComment, ReviewThread } from "../../../lib/pr/types";
import Markdown from "../../Markdown";
import PrChecks from "../../pr/PrChecks";
import PrDescription from "../../pr/PrDescription";
import PrReviewers from "../../pr/PrReviewers";
import { ThreadView } from "../../pr/ThreadView";
import { useThreadActions } from "../../pr/useThreadActions";
import type { TabContext } from "./types";

/** The scrolling page a static tab's content sits on. */
export function TabPage({ children }: { children: ReactNode }) {
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl space-y-4 px-6 py-5">{children}</div>
    </div>
  );
}

export function DescriptionTab({ ctx }: { ctx: TabContext }) {
  return (
    <TabPage>
      <PrDescription prRef={ctx.prRef} />
    </TabPage>
  );
}

export function ReviewersTab({ ctx }: { ctx: TabContext }) {
  return (
    <TabPage>
      <PrReviewers prRef={ctx.prRef} />
    </TabPage>
  );
}

export function ChecksTab({ ctx }: { ctx: TabContext }) {
  return (
    <TabPage>
      <PrChecks prRef={ctx.prRef} />
    </TabPage>
  );
}

/** Threads on a file, by path in the order the provider listed them first. */
export function groupThreadsByPath(threads: ReviewThread[]): {
  general: ReviewThread[];
  files: { path: string; threads: ReviewThread[] }[];
} {
  const general: ReviewThread[] = [];
  const byPath = new Map<string, ReviewThread[]>();
  for (const t of threads) {
    if (!t.path) {
      general.push(t);
      continue;
    }
    const list = byPath.get(t.path) ?? [];
    list.push(t);
    byPath.set(t.path, list);
  }
  return { general, files: [...byPath].map(([path, threads]) => ({ path, threads })) };
}

/** Comments on the PR itself, oldest first, as the provider's conversation shows them. */
function Conversation({ comments, truncated }: { comments: ReviewComment[]; truncated: boolean }) {
  return (
    <section className="space-y-2">
      <h4 className="text-xs font-medium uppercase tracking-wide text-zinc-500">Conversation</h4>
      {truncated && (
        <p className="text-xs text-amber-400">
          Showing the latest {comments.length}; open the PR on the provider for the rest.
        </p>
      )}
      {comments.map((c, i) => (
        <div
          key={c.id || `at-${i}`}
          className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3"
        >
          <div className="mb-1 flex items-center gap-2 text-xs">
            <span className="font-medium text-zinc-400">{c.author}</span>
            {c.createdAt && (
              <span className="text-zinc-600">{new Date(c.createdAt).toLocaleString()}</span>
            )}
          </div>
          <Markdown allowImages>{c.body}</Markdown>
        </div>
      ))}
    </section>
  );
}

/**
 * Every comment on the PR: the conversation on the PR itself, then the
 * general review threads, then the inline ones by
 * file, each with a jump into that file's diff at the thread's line. Resolved
 * threads are hidden by default, since what is left to answer is what a
 * reviewer comes here for.
 */
export function CommentsTab({ ctx }: { ctx: TabContext }) {
  const { data: detail, error, loading } = usePrDetail(ctx.prRef);
  const threads = detail?.reviewThreads ?? [];
  const actions = useThreadActions(ctx.prRef, threads);
  const [showResolved, setShowResolved] = useState(false);
  const resolvedCount = threads.filter((t) => t.isResolved).length;
  const shown = useMemo(
    () => (showResolved ? threads : threads.filter((t) => !t.isResolved)),
    [threads, showResolved],
  );
  const { general, files } = groupThreadsByPath(shown);
  const conversation = detail?.conversation ?? [];

  return (
    <TabPage>
      <div className="flex items-center gap-3">
        <h3 className="text-sm font-medium uppercase tracking-wide text-zinc-500">Comments</h3>
        <span className="text-xs text-zinc-500">
          {threads.length - resolvedCount} open · {resolvedCount} resolved
        </span>
        {resolvedCount > 0 && (
          <button
            type="button"
            onClick={() => setShowResolved((v) => !v)}
            className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {showResolved ? "Hide resolved" : "Show resolved"}
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {loading && <p className="text-sm text-zinc-500">Loading comments…</p>}
      {conversation.length > 0 && (
        <Conversation comments={conversation} truncated={detail?.conversationTruncated ?? false} />
      )}
      {detail && shown.length === 0 && (
        <p className="text-sm text-zinc-500">
          {threads.length > 0
            ? "Every thread is resolved."
            : conversation.length === 0
              ? "No comments yet."
              : "No review threads."}
        </p>
      )}
      {detail?.reviewThreadsTruncated && (
        <p className="text-xs text-amber-400">
          This PR has more threads than were loaded; open it on the provider to see them all.
        </p>
      )}
      {general.map((t) => (
        <ThreadView key={t.id} {...actions.viewProps(t)} />
      ))}
      {files.map(({ path, threads: fileThreads }) => (
        <section key={path} className="space-y-2">
          <button
            type="button"
            onClick={() => ctx.openTab({ kind: "diff", prId: ctx.pr.id, path })}
            className="font-mono text-xs text-zinc-300 hover:text-indigo-300"
            title="Open the diff"
          >
            {path}
          </button>
          {fileThreads.map((t) => (
            <div key={t.id} className="space-y-1">
              {t.line != null && (
                <button
                  type="button"
                  onClick={() =>
                    ctx.openTab({
                      kind: "diff",
                      prId: ctx.pr.id,
                      path,
                      revealLine: t.line ?? undefined,
                    })
                  }
                  className="text-xs text-indigo-300 hover:text-indigo-200"
                >
                  Go to line {t.line} →
                </button>
              )}
              <ThreadView {...actions.viewProps(t)} />
            </div>
          ))}
        </section>
      ))}
    </TabPage>
  );
}
