import { useState } from "react";
import { refProviderName } from "../../lib/pr/ref";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { openInReviewWorkspace } from "../../lib/reviewWorkspaces/open";
import {
  type ProviderReviewMark,
  useProviderReviewMark,
} from "../../lib/reviewWorkspaces/sinceReview";

/**
 * What the note says, or null when there is nothing to say: no review on
 * record, or none of it has moved since. A count is only given when the
 * provider could give one; a force-push leaves just the fact that it moved.
 */
export function sinceReviewNoteText(answer: ProviderReviewMark | null): string | null {
  if (!answer?.mark || !answer.since) return null;
  const { commits, exists, rewritten } = answer.since;
  if (!rewritten && commits === 0) return null;
  if (!exists) return "Rewritten since your last review — the commit you reviewed is gone.";
  if (rewritten) return "Force-pushed since your last review.";
  if (commits === null) return "New commits since your last review.";
  return `${commits} new ${commits === 1 ? "commit" : "commits"} since your review.`;
}

/**
 * The classic page's pointer to "what changed since I last reviewed": a line
 * under the header when the PR has moved on from the user's last review
 * (made here, in a review workspace, or on the provider's site), linking to
 * the review workspace's tab that answers it properly.
 */
export default function SinceReviewNote({
  prRef,
  title,
  detail,
}: {
  prRef: PrRef;
  title: string;
  detail: PrDetail | null;
}) {
  const answer = useProviderReviewMark(prRef, detail?.headSha || null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const text = sinceReviewNoteText(answer.data);
  if (!text) return null;
  const viaProvider = answer.data?.mark?.source === "provider";

  const open = async () => {
    setOpening(true);
    setError(null);
    try {
      await openInReviewWorkspace(prRef, title, "since-review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setOpening(false);
    }
  };

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-sky-900 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-100">
      <span>
        {text}
        {viaProvider ? ` (your last review was on ${refProviderName(prRef)})` : ""}
      </span>
      <button
        type="button"
        disabled={opening}
        onClick={() => void open()}
        className="rounded border border-sky-800 px-2 py-0.5 hover:bg-sky-900/50 disabled:opacity-50"
      >
        {opening ? "Opening…" : "See what changed in a review workspace"}
      </button>
      {error && <span className="text-red-300">{error}</span>}
    </div>
  );
}
