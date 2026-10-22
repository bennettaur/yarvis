import { usePrDetail } from "../../lib/pr/cache";
import type { PrRef, ReviewThread } from "../../lib/pr/types";
import LoadingIndicator from "../LoadingIndicator";
import Markdown from "../Markdown";
import { ThreadView } from "./ThreadView";
import { type ThreadActions, useThreadActions } from "./useThreadActions";

/** Stable across renders, so the thread actions don't recompute while loading. */
const NO_THREADS: ReviewThread[] = [];

function ThreadsSection({ threads, actions }: { threads: ReviewThread[]; actions: ThreadActions }) {
  if (threads.length === 0) {
    return <p className="text-sm text-zinc-600">No general comments.</p>;
  }
  return (
    <div className="space-y-3">
      {threads.map((t, i) => (
        // Ids are empty only on data from before ids were carried.
        <ThreadView key={t.id || i} showLocation {...actions.viewProps(t)} />
      ))}
    </div>
  );
}

/**
 * A PR's description (markdown body) together with the review threads that
 * can't be anchored inline in the diff — general PR comments and threads the
 * provider can no longer place on a line. File/line threads render beside
 * their diff line instead.
 */
export default function PrDescription({ prRef }: { prRef: PrRef }) {
  const { data, error, loading } = usePrDetail(prRef);
  const threads = data?.reviewThreads ?? NO_THREADS;
  const actions = useThreadActions(prRef, threads);

  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <LoadingIndicator />;

  const general = threads.filter((t) => t.path == null || t.line == null);

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
        <ThreadsSection threads={general} actions={actions} />
      </section>
    </div>
  );
}
