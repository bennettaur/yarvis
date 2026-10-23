import { useEffect, useState } from "react";
import { requestOpenWorkspace } from "../../lib/nav";
import { invalidate, prDetailKey } from "../../lib/pr/cache";
import {
  prConflictState,
  type ResolveConflictsResult,
  resolvePrConflicts,
} from "../../lib/pr/conflicts";
import { refKey } from "../../lib/pr/ref";
import type { PrDetail, PrRef } from "../../lib/pr/types";

/**
 * How long to wait before asking again when the provider hasn't worked out
 * mergeability yet. GitHub computes it on the first read after a push and
 * usually has an answer within a few seconds.
 */
export const MERGEABILITY_RECHECK_MS = 5_000;

type Step =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirm"; reason: string }
  | { kind: "done"; result: Exclude<ResolveConflictsResult, { outcome: "needs_confirm" }> }
  | { kind: "error"; message: string };

function doneMessage(result: Extract<Step, { kind: "done" }>["result"]): string {
  switch (result.outcome) {
    case "sent":
      return `Sent to the agent in “${result.name}”.`;
    case "started":
      return `Started an agent in “${result.name}” on it.`;
    case "created":
      return `Created “${result.name}”; its agent starts on the conflicts once it is set up.`;
  }
}

const FORK_REASON =
  "This pull request comes from a fork, so its branch can't be checked out in a workspace";

/**
 * The conflict state at the top of a PR's header — the classic review's and a
 * review workspace's — with the button that hands the conflicts to a coding
 * agent. Renders nothing unless the PR conflicts with its base; while the
 * provider is still computing that, it asks once more after a short wait.
 * Hosts key it on the PR (`refKey`), so switching PRs drops the last one's
 * progress and recheck.
 *
 * Where the agent comes from is the sidecar's call (`resolvePrConflicts`): the
 * one already running in the PR's workspace, one started there, or one in a
 * workspace created for the PR, which this then opens as "Start workspace"
 * does. Typing into a busy agent is confirmed first.
 */
export default function PrConflictBanner({
  prRef,
  detail,
  recheckMs = MERGEABILITY_RECHECK_MS,
}: {
  prRef: PrRef;
  detail: PrDetail | null;
  /** Overridable so tests needn't wait out the real delay. */
  recheckMs?: number;
}) {
  const state = prConflictState(detail);
  const [step, setStep] = useState<Step>({ kind: "idle" });
  const [rechecked, setRechecked] = useState(false);

  // Once per mount, so a PR that stays UNKNOWN is asked about once rather than polled.
  const key = refKey(prRef);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on ref identity, not the unstable ref object
  useEffect(() => {
    if (state !== "computing" || rechecked) return;
    const timer = setTimeout(() => {
      setRechecked(true);
      invalidate(prDetailKey(prRef));
    }, recheckMs);
    return () => clearTimeout(timer);
  }, [state, rechecked, key, recheckMs]);

  if (state !== "conflicts" || !detail) return null;

  const run = async (confirm: boolean) => {
    setStep({ kind: "pending" });
    try {
      const result = await resolvePrConflicts(prRef, confirm);
      if (result.outcome === "needs_confirm") {
        setStep({ kind: "confirm", reason: result.reason });
        return;
      }
      setStep({ kind: "done", result });
      invalidate(prDetailKey(prRef));
      // Switch to it, as "Start workspace" does: the workspace view joins the
      // provisioning already running and the agent starts there.
      if (result.outcome === "created") requestOpenWorkspace({ id: result.workspaceId });
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  const fork = detail.fromFork;
  const pending = step.kind === "pending";
  const secondary =
    "shrink-0 rounded-md border border-red-800/80 px-2 py-1 text-xs text-red-100 hover:bg-red-900/50 disabled:opacity-50";

  return (
    <div
      role="status"
      data-testid="pr-conflict-banner"
      className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-red-800/70 bg-red-950/50 px-3 py-1.5 text-xs text-red-200"
    >
      <span className="shrink-0 rounded bg-red-900/70 px-2 py-0.5 font-medium text-red-100">
        Conflicts with {detail.baseRef || "the base branch"}
      </span>
      <span className="min-w-0 flex-1 text-red-200/80">
        {fork
          ? `${FORK_REASON}; resolve them on ${detail.headRef || "the fork"} itself.`
          : "This branch can't merge until they're resolved."}
      </span>
      {step.kind === "confirm" ? (
        <>
          <span className="shrink-0 font-medium text-amber-200">{step.reason} Send anyway?</span>
          <button type="button" onClick={() => void run(true)} className={secondary}>
            Send anyway
          </button>
          <button type="button" onClick={() => setStep({ kind: "idle" })} className={secondary}>
            Cancel
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => void run(false)}
          disabled={pending || fork}
          title={
            fork
              ? FORK_REASON
              : "Have a coding agent merge the base branch into this PR, resolve the conflicts and push"
          }
          className="shrink-0 rounded-md bg-red-600 px-3 py-1 text-xs font-medium text-white shadow-sm hover:bg-red-500 disabled:opacity-50"
        >
          {pending ? "Handing off…" : "Resolve conflicts"}
        </button>
      )}
      {step.kind === "done" && (
        <>
          <span className="shrink-0 text-emerald-300">{doneMessage(step.result)}</span>
          <button
            type="button"
            onClick={() => requestOpenWorkspace({ id: step.result.workspaceId })}
            className={secondary}
          >
            Open workspace
          </button>
        </>
      )}
      {step.kind === "error" && (
        <span role="alert" className="basis-full text-red-400">
          {step.message}
        </span>
      )}
    </div>
  );
}
