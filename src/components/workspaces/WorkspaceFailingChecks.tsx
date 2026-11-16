import { useState } from "react";
import { requestOpenWorkspace } from "../../lib/nav";
import { usePrDetail } from "../../lib/pr/cache";
import type { AgentHandOffResult } from "../../lib/pr/conflicts";
import { fixPrChecks, isFailingCheck } from "../../lib/pr/fixChecks";
import type { PrRef } from "../../lib/pr/types";
import LoadingIndicator from "../LoadingIndicator";
import { ChecksList } from "../pr/PrChecks";

type Delivered = Exclude<AgentHandOffResult, { outcome: "needs_confirm" }>;

type Step =
  | { kind: "idle" }
  | { kind: "pending" }
  | { kind: "confirm"; reason: string }
  | { kind: "done"; result: Delivered }
  /** Asking whether to send again, so a stray second click doesn't. */
  | { kind: "again"; result: Delivered }
  | { kind: "error"; message: string };

function doneMessage(result: Delivered): string {
  switch (result.outcome) {
    case "sent":
      return `Sent to the agent in “${result.name}”.`;
    case "started":
      return `Started an agent in “${result.name}” to fix the failing checks.`;
    case "created":
      return `Created “${result.name}”; its agent starts on the checks once it is set up.`;
  }
}

const secondaryButton =
  "rounded-md border border-zinc-700 px-2 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50";

/**
 * Every check on a workspace's PR, with the failing ones pulled to the top and
 * a button that hands them to the workspace's coding agent. The list is the
 * PR's live detail rather than the poller's counts, so each check can be named
 * and opened. Typing into a busy agent, and sending a second time, are
 * confirmed first, as for conflicts. Hosts key it on the PR (`refKey`).
 */
export default function WorkspaceFailingChecks({ prRef }: { prRef: PrRef }) {
  const { data, error, loading, refreshing, refresh } = usePrDetail(prRef);
  const [step, setStep] = useState<Step>({ kind: "idle" });

  if (error) return <p className="text-xs text-red-400">{error}</p>;
  if (loading || !data) return <LoadingIndicator className="text-xs text-zinc-500" />;

  const failing = data.checks.filter(isFailingCheck);
  const fork = data.fromFork;
  // The sidecar refuses anything else, so say so before the click.
  const closed = !["open", "active"].includes(data.state.toLowerCase());
  const pending = step.kind === "pending";

  const run = async (confirm: boolean) => {
    setStep({ kind: "pending" });
    try {
      const result = await fixPrChecks(prRef, confirm);
      if (result.outcome === "needs_confirm") {
        setStep({ kind: "confirm", reason: result.reason });
        return;
      }
      setStep({ kind: "done", result });
      if (result.outcome === "created") requestOpenWorkspace({ id: result.workspaceId });
    } catch (e) {
      setStep({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <div className="space-y-3">
      {failing.length > 0 && (
        <section
          data-testid="failing-checks"
          className="space-y-2 rounded-md border border-red-900/60 bg-red-950/30 p-2"
        >
          <h3 className="text-xs font-medium text-red-200">
            {failing.length} failing check{failing.length === 1 ? "" : "s"}
          </h3>
          <ChecksList checks={failing} />
          <div className="flex flex-wrap items-center gap-1.5 text-xs">
            {step.kind === "confirm" && (
              <>
                <span className="text-amber-200">{step.reason} Send anyway?</span>
                <button type="button" onClick={() => void run(true)} className={secondaryButton}>
                  Send anyway
                </button>
                <button
                  type="button"
                  onClick={() => setStep({ kind: "idle" })}
                  className={secondaryButton}
                >
                  Cancel
                </button>
              </>
            )}
            {(step.kind === "idle" || step.kind === "pending" || step.kind === "error") && (
              <button
                type="button"
                onClick={() => void run(false)}
                disabled={pending || fork || closed}
                title={
                  fork
                    ? "This pull request comes from a fork, so its branch can't be checked out in a workspace"
                    : closed
                      ? "This pull request is no longer open"
                      : "Have the workspace's coding agent read the failing checks' logs, fix what the PR broke and push"
                }
                className="rounded-md bg-red-600 px-2 py-1 font-medium text-white hover:bg-red-500 disabled:opacity-50"
              >
                {pending ? "Handing off…" : "Fix with Claude"}
              </button>
            )}
            {(step.kind === "done" || step.kind === "again") && (
              <span role="status" className="text-emerald-300">
                {doneMessage(step.result)}
              </span>
            )}
            {step.kind === "done" && (
              <button
                type="button"
                onClick={() => setStep({ kind: "again", result: step.result })}
                title="Hand the failing checks to the agent again"
                className={secondaryButton}
              >
                Send again
              </button>
            )}
            {step.kind === "again" && (
              <>
                <span className="text-amber-200">Send the instructions again?</span>
                <button type="button" onClick={() => void run(false)} className={secondaryButton}>
                  Yes, send again
                </button>
                <button
                  type="button"
                  onClick={() => setStep({ kind: "done", result: step.result })}
                  className={secondaryButton}
                >
                  Cancel
                </button>
              </>
            )}
            {step.kind === "error" && (
              <span role="alert" className="basis-full text-red-400">
                {step.message}
              </span>
            )}
          </div>
        </section>
      )}
      <div>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="text-xs font-medium text-zinc-400">All checks</h3>
          <button
            type="button"
            onClick={() => void refresh()}
            disabled={refreshing}
            className="rounded border border-zinc-700 px-1.5 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "Refresh"}
          </button>
        </div>
        <ChecksList checks={data.checks} unavailable={data.checksUnavailable} />
      </div>
    </div>
  );
}
