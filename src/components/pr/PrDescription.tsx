import type { ReviewThread } from "../../lib/github";
import { usePrDetail } from "../../lib/githubCache";
import Markdown from "../Markdown";
import type { PrRef } from "./shared";

function ThreadsSection({ threads }: { threads: ReviewThread[] }) {
  if (threads.length === 0) {
    return <p className="text-sm text-zinc-600">No review comments.</p>;
  }
  return (
    <div className="space-y-3">
      {threads.map((t, i) => (
        <div key={i} className="rounded-lg border border-zinc-800 bg-zinc-900/50 p-3">
          <div className="mb-2 flex items-center gap-2 text-xs">
            <span className="font-mono text-zinc-400">
              {t.path ?? "(general)"}
              {t.line != null ? `:${t.line}` : ""}
            </span>
            <span className={t.isResolved ? "text-emerald-500" : "text-amber-500"}>
              {t.isResolved ? "resolved" : "open"}
            </span>
          </div>
          <div className="space-y-2">
            {t.comments.map((cm, j) => (
              <div key={j}>
                <div className="text-xs font-medium text-zinc-400">{cm.author}</div>
                <Markdown>{cm.body}</Markdown>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

/** A PR's description (markdown body) together with its review comment threads. */
export default function PrDescription({ owner, repo, number }: PrRef) {
  const { data, error, loading } = usePrDetail(owner, repo, number);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-5">
      <section>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Description
        </h3>
        {data.body.trim() ? (
          <Markdown>{data.body}</Markdown>
        ) : (
          <p className="text-sm text-zinc-600">No description.</p>
        )}
      </section>
      <section>
        <h3 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">Comments</h3>
        <ThreadsSection threads={data.reviewThreads} />
      </section>
    </div>
  );
}
