import { useEffect, useRef, useState } from "react";
import {
  followReviewPrProgress,
  type ReviewWorkspacePr,
  refreshReviewPr,
} from "../../lib/reviewWorkspaces/api";
import { invalidateLastReview } from "../../lib/reviewWorkspaces/sinceReview";

/** Whether the provider has moved past the checkout: someone pushed since it was fetched. */
export function hasNewCommits(
  pr: Pick<ReviewWorkspacePr, "status" | "headSha">,
  providerHead: string | null | undefined,
): boolean {
  return pr.status === "ready" && !!pr.headSha && !!providerHead && providerHead !== pr.headSha;
}

type Phase =
  | { kind: "idle" }
  | { kind: "refreshing"; line: string | null }
  | { kind: "done" }
  | { kind: "failed"; error: string };

/**
 * The PR bar's "New commits pushed — Refresh": shown when the provider's head
 * (from the PR detail) is not the checkout's. Refreshing moves the checkout and
 * follows the run's log until it ends; the open tabs stay as they are and read
 * the new commits on their own. Afterwards it offers the since-review tab,
 * which is what a re-review usually wants next.
 */
export default function NewCommitsBanner({
  workspaceId,
  pr,
  providerHead,
  readOnly,
  onRefreshed,
  onSeeChanges,
}: {
  workspaceId: string;
  pr: Pick<ReviewWorkspacePr, "id" | "ref" | "status" | "headSha">;
  providerHead: string | null | undefined;
  readOnly: boolean;
  /** The checkout moved: re-read the workspace. */
  onRefreshed: () => void;
  onSeeChanges: () => void;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const abort = useRef<AbortController | null>(null);
  useEffect(() => () => abort.current?.abort(), []);

  const refresh = async () => {
    setPhase({ kind: "refreshing", line: null });
    abort.current?.abort();
    const controller = new AbortController();
    abort.current = controller;
    try {
      await refreshReviewPr(workspaceId, pr.id);
      let failure: string | null = null;
      for await (const event of followReviewPrProgress(workspaceId, pr.id, controller.signal)) {
        if (event.type === "log") {
          const line = event.text.trim().split("\n").pop()?.trim();
          if (line) setPhase({ kind: "refreshing", line });
        } else if (event.type === "done") {
          failure = event.error;
          break;
        }
      }
      if (controller.signal.aborted) return;
      invalidateLastReview(pr.ref);
      onRefreshed();
      setPhase(failure ? { kind: "failed", error: failure } : { kind: "done" });
    } catch (e) {
      if (!controller.signal.aborted) {
        setPhase({ kind: "failed", error: e instanceof Error ? e.message : String(e) });
      }
    }
  };

  const behind = hasNewCommits(pr, providerHead);
  if (phase.kind === "done") {
    return (
      <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-emerald-800 bg-emerald-950/30 px-3 py-1.5 text-xs text-emerald-100">
        <span>Checkout updated to the latest commits. Your tabs now show them.</span>
        <button
          type="button"
          onClick={() => {
            setPhase({ kind: "idle" });
            onSeeChanges();
          }}
          className="rounded border border-emerald-700 px-2 py-0.5 hover:bg-emerald-900/50"
        >
          See what changed since you last reviewed
        </button>
        <button
          type="button"
          aria-label="Dismiss"
          onClick={() => setPhase({ kind: "idle" })}
          className="ml-auto px-1 text-emerald-300 hover:text-emerald-100"
        >
          ×
        </button>
      </div>
    );
  }
  if (!behind && phase.kind !== "refreshing" && phase.kind !== "failed") return null;
  return (
    <div
      role="status"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-sky-800 bg-sky-950/30 px-3 py-1.5 text-xs text-sky-100"
    >
      {phase.kind === "refreshing" ? (
        <span className="animate-pulse">
          Updating the checkout{phase.line ? ` · ${phase.line}` : "…"}
        </span>
      ) : (
        <>
          <span>
            New commits pushed — the PR is at{" "}
            <span className="font-mono">{providerHead?.slice(0, 7)}</span>, this checkout at{" "}
            <span className="font-mono">{pr.headSha?.slice(0, 7)}</span>.
          </span>
          {!readOnly && (
            <button
              type="button"
              onClick={() => void refresh()}
              className="rounded border border-sky-700 px-2 py-0.5 hover:bg-sky-900/50"
            >
              Refresh
            </button>
          )}
        </>
      )}
      {phase.kind === "failed" && (
        <span className="text-red-300">Update failed: {phase.error}</span>
      )}
    </div>
  );
}
