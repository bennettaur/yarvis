import { usePrDetail } from "../../lib/pr/cache";
import type { PrRef, ReviewThread } from "../../lib/pr/types";
import Markdown from "../Markdown";

/** One review thread rendered as a card. Reused for inline diff threads too. */
export function ThreadCard({ thread }: { thread: ReviewThread }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
      <div className="mb-2 flex items-center gap-2 text-xs">
        <span className="font-mono text-zinc-400">
          {thread.path ?? "(general)"}
          {thread.line != null ? `:${thread.line}` : ""}
        </span>
        <span className={thread.isResolved ? "text-emerald-500" : "text-amber-500"}>
          {thread.isResolved ? "resolved" : "open"}
        </span>
      </div>
      <div className="space-y-2">
        {thread.comments.map((cm, j) => (
          <div key={j}>
            <div className="text-xs font-medium text-zinc-400">{cm.author}</div>
            <Markdown allowImages>{cm.body}</Markdown>
          </div>
        ))}
      </div>
    </div>
  );
}

function ThreadsSection({ threads }: { threads: ReviewThread[] }) {
  if (threads.length === 0) {
    return <p className="text-sm text-zinc-600">No general comments.</p>;
  }
  return (
    <div className="space-y-3">
      {threads.map((t, i) => (
        <ThreadCard key={i} thread={t} />
      ))}
    </div>
  );
}

/**
 * A PR's description (markdown body) together with the review threads that
 * can't be anchored inline in the diff — general PR comments and threads with
 * no right-side line. File/line threads render beside their diff line instead.
 */
export default function PrDescription({ prRef }: { prRef: PrRef }) {
  const { data, error, loading } = usePrDetail(prRef);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading…</p>;

  const general = data.reviewThreads.filter((t) => t.path == null || t.line == null);

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Description
        </h3>
        {data.body.trim() ? (
          <Markdown allowImages>{data.body}</Markdown>
        ) : (
          <p className="text-sm text-zinc-600">No description.</p>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">Comments</h3>
        <ThreadsSection threads={general} />
      </section>
    </div>
  );
}
