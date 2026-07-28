import { usePrDetail } from "../../lib/pr/cache";
import type { PrRef, Reviewer, ReviewerState } from "../../lib/pr/types";

/**
 * Per-state visual treatment. Approvals and changes-requested carry the same
 * weight the provider UIs give them (green / red); pending and commented are
 * neutral; dismissed is muted so a stale-review reviewer doesn't compete with
 * the fresh signals.
 */
const STATE_META: Record<ReviewerState, { label: string; badge: string; dot: string }> = {
  approved: {
    label: "Approved",
    badge: "bg-emerald-900/60 text-emerald-200",
    dot: "bg-emerald-500",
  },
  changes_requested: {
    label: "Changes requested",
    badge: "bg-red-900/60 text-red-200",
    dot: "bg-red-500",
  },
  commented: {
    label: "Commented",
    badge: "bg-zinc-800 text-zinc-200",
    dot: "bg-zinc-400",
  },
  pending: {
    label: "Awaiting review",
    badge: "bg-amber-900/40 text-amber-200",
    dot: "bg-amber-500",
  },
  dismissed: {
    label: "Dismissed",
    badge: "bg-zinc-800 text-zinc-500",
    dot: "bg-zinc-600",
  },
};

/**
 * Sort so the reviewers with the loudest verdicts float to the top: any
 * requested-but-outstanding review first (that's what the viewer typically
 * cares about), then changes-requested, then approvals, then everything else.
 * Within a bucket, sort by login for a stable order.
 */
function reviewerRank(reviewer: Reviewer): number {
  if (reviewer.isRequested) return 0;
  switch (reviewer.state) {
    case "changes_requested":
      return 1;
    case "approved":
      return 2;
    case "commented":
      return 3;
    case "dismissed":
      return 4;
    default:
      return 5;
  }
}

export function sortReviewers(reviewers: Reviewer[]): Reviewer[] {
  return [...reviewers].sort((a, b) => {
    const diff = reviewerRank(a) - reviewerRank(b);
    if (diff !== 0) return diff;
    return a.login.localeCompare(b.login);
  });
}

function ReviewerRow({ reviewer }: { reviewer: Reviewer }) {
  const meta = STATE_META[reviewer.state];
  return (
    <div className="flex items-center justify-between gap-3 rounded-md border border-zinc-800 bg-zinc-900/50 px-3 py-2 text-sm">
      <div className="flex min-w-0 items-center gap-2">
        <span className={`h-2 w-2 shrink-0 rounded-full ${meta.dot}`} aria-hidden />
        <span className="truncate text-zinc-200">{reviewer.login}</span>
      </div>
      <span className={`shrink-0 rounded px-2 py-0.5 text-xs font-medium ${meta.badge}`}>
        {meta.label}
      </span>
    </div>
  );
}

/**
 * Presentational reviewer list. Kept separate from the container so tests can
 * render a fixed reviewer list without stubbing the cache hook (which is
 * process-global in bun and would leak into unrelated cache tests).
 */
export function ReviewersList({ reviewers }: { reviewers: Reviewer[] }) {
  if (reviewers.length === 0) {
    return <p className="text-sm text-zinc-600">No reviewers requested.</p>;
  }
  return (
    <div className="space-y-2">
      {sortReviewers(reviewers).map((reviewer) => (
        <ReviewerRow key={reviewer.login} reviewer={reviewer} />
      ))}
    </div>
  );
}

/**
 * The Reviewers panel on the PR review page. Lists requested reviewers and the
 * verdict of anyone who has already reviewed, so the viewer can see at a glance
 * who is expected to weigh in and where the PR stands review-wise without
 * scrolling through the timeline.
 *
 * Reuses the shared PR detail cache — no extra fetch.
 */
export default function PrReviewers({ prRef }: { prRef: PrRef }) {
  const { data, error, loading } = usePrDetail(prRef);
  if (error) return <p className="text-sm text-red-400">{error}</p>;
  if (loading || !data) return <p className="text-sm text-zinc-500">Loading…</p>;
  return <ReviewersList reviewers={data.reviewers} />;
}
