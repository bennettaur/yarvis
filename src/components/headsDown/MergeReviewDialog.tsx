import { useEffect, useRef, useState } from "react";
import type { AttentionItem } from "../../lib/attention";
import { answerQuestion, type MergeReview, type PrFeedback } from "../../lib/headsDown";

/**
 * Asks the user about a merge heads-down mode held back because the PR has
 * open review feedback. Approve lets the merge run on the next pass. Review
 * denies it and opens the PR, so the user can look at the feedback themselves.
 * Escape puts it away for now; it still waits under Needs you.
 */
export default function MergeReviewDialog({
  item,
  review,
  more,
  onOpen,
  onDefer,
}: {
  item: AttentionItem;
  review: MergeReview;
  /** How many other held merges are waiting behind this one. */
  more: number;
  onOpen: (item: AttentionItem) => void;
  onDefer: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reviewRef = useRef<HTMLButtonElement>(null);
  const firstPr = review.prs[0];

  // Focus starts on Review, so Enter can't approve a merge by accident.
  useEffect(() => {
    reviewRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopImmediatePropagation();
      onDefer();
    };
    window.addEventListener("keydown", onKey, { capture: true });
    return () => window.removeEventListener("keydown", onKey, { capture: true });
  }, [onDefer]);

  const answer = async (choice: "approve" | "deny") => {
    setBusy(true);
    setError(null);
    try {
      await answerQuestion(review.questionId, { choice });
      if (choice === "deny" && firstPr) {
        const [owner, repo] = firstPr.repo.split("/");
        if (owner && repo) {
          onOpen({ ...item, navTarget: { type: "pr", owner, repo, number: firstPr.number } });
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  const label = firstPr ? `${firstPr.repo}#${firstPr.number}` : "a PR";
  const heading =
    review.unchecked !== null
      ? "Heads down wants to merge a PR it couldn't check for feedback"
      : "Heads down wants to merge a PR with open feedback";

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60" />
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={`Heads down wants to merge ${label}`}
        className="relative flex max-h-[85vh] w-[600px] max-w-full flex-col rounded-lg border-2 border-amber-500/70 bg-zinc-900 shadow-2xl"
      >
        <div className="space-y-3 overflow-y-auto px-5 py-4">
          <div className="text-xs font-semibold uppercase tracking-wide text-amber-300">
            {heading}
          </div>
          {review.unchecked !== null && (
            <p className="text-sm text-zinc-300">
              It couldn't check the PR for open review feedback: {review.unchecked}
            </p>
          )}
          {review.prs.map((pr) => (
            <PrFeedbackView key={`${pr.repo}#${pr.number}`} pr={pr} />
          ))}
          {error && <p className="text-sm text-red-300">{error}</p>}
          {more > 0 && (
            <p className="text-xs text-zinc-500">
              {more} more merge{more > 1 ? "s" : ""} waiting on you.
            </p>
          )}
        </div>
        <footer className="flex items-center justify-end gap-2 border-t border-zinc-800 px-5 py-3">
          <button
            ref={reviewRef}
            type="button"
            disabled={busy}
            onClick={() => void answer("deny")}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Review, don't merge
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void answer("approve")}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-500 disabled:opacity-50"
          >
            Approve merge
          </button>
        </footer>
      </div>
    </div>
  );
}

function PrFeedbackView({ pr }: { pr: PrFeedback }) {
  const hidden = pr.threadCount - pr.threads.length;
  return (
    <section className="space-y-2">
      <div>
        <div className="text-lg font-semibold text-zinc-100">
          {pr.repo}#{pr.number}
        </div>
        {pr.title && (
          <div className="text-sm text-zinc-300">
            <span className="text-zinc-500">PR title: </span>
            {pr.title}
          </div>
        )}
        <p className="mt-1 text-xs text-zinc-400">
          {pr.handedOff
            ? "Its workspace was asked to address this and left it open."
            : pr.workspaceId
              ? "Its workspace couldn't be asked to address this."
              : "No workspace has this PR, so nobody was asked to address it."}
        </p>
      </div>
      {pr.changesRequestedBy.length > 0 && (
        <p className="text-sm text-red-200">
          Changes requested by {pr.changesRequestedBy.join(", ")}
        </p>
      )}
      <ul className="space-y-2">
        {pr.threads.map((t, i) => (
          <li
            // biome-ignore lint/suspicious/noArrayIndexKey: threads have no id in the payload, and their order doesn't change
            key={i}
            className="rounded-md border border-zinc-800 bg-zinc-950/60 px-3 py-2"
          >
            <div className="text-xs text-zinc-500">
              <span className="text-zinc-400">Reviewer comment</span> from {t.author}
              {t.path && (
                <>
                  {" on "}
                  <span className="font-mono">
                    {t.path}
                    {t.line !== null ? `:${t.line}` : ""}
                  </span>
                </>
              )}
              {t.outdated && " (outdated)"}
              {t.replies > 0 && ` · ${t.replies} repl${t.replies === 1 ? "y" : "ies"}`}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm text-zinc-200">{t.body}</p>
          </li>
        ))}
      </ul>
      {(hidden > 0 || pr.threadsTruncated) && (
        <p className="text-xs text-zinc-500">
          {hidden > 0
            ? `${hidden} more unresolved thread${hidden > 1 ? "s" : ""} on the PR.`
            : "The PR may have more threads that couldn't be loaded."}
        </p>
      )}
    </section>
  );
}
