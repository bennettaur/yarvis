import { useEffect, useState } from "react";
import { cancelAgentRun, streamAgentRun } from "../../../lib/agentRuns";
import { invalidate } from "../../../lib/resourceCache";
import { startFlowDiagram } from "../../../lib/reviewWorkspaces/flowDiagram";
import { Loader } from "../../ai-elements/loader";
import LoadingIndicator from "../../LoadingIndicator";
import FlowDiagram from "./FlowDiagram";
import { flowDiagramKey, useLatestFlowDiagram } from "./reviewData";
import type { TabContext } from "./types";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/**
 * Starts a diagram run for the PR, then re-reads its latest run so the tab
 * picks the new one up. Shared by the tab and the nav's run button.
 */
export async function runFlowDiagram(workspaceId: string, prId: string): Promise<void> {
  await startFlowDiagram(workspaceId, prId);
  invalidate(flowDiagramKey(prId));
}

/** What a running diagram is doing, from its events; re-reads the latest run when it ends. */
function useRunActivity(prId: string, runId: string | null) {
  const [activity, setActivity] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    // An error outlives its run, so the failed notice can still say what went wrong.
    if (!runId) return;
    setActivity(null);
    setError(null);
    const abort = new AbortController();
    void (async () => {
      try {
        for await (const event of streamAgentRun(runId, abort.signal)) {
          if (event.type === "tool") {
            setActivity(event.summary ? `${event.name} ${event.summary}` : event.name);
          } else if (event.type === "status") setActivity(event.message);
          else if (event.type === "error") setError(event.message);
        }
      } catch (e) {
        if (abort.signal.aborted) return;
        setError(`Lost track of the run: ${e instanceof Error ? e.message : String(e)}`);
      }
      if (!abort.signal.aborted) invalidate(flowDiagramKey(prId));
    })();
    return () => abort.abort();
  }, [prId, runId]);
  return { activity, error };
}

/**
 * The PR's flow diagram: an agent traces the flow the change sits in, from
 * what starts it to where it ends, and draws it as a flowchart with the
 * changed steps marked. Generated only when asked for.
 */
export default function DiagramTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const latest = useLatestFlowDiagram(workspaceId, pr.id);
  const [starting, setStarting] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  const run = latest.data?.run ?? null;
  const followId = run?.status === "running" && run.live ? run.id : null;
  const progress = useRunActivity(pr.id, followId);
  const running = followId !== null;
  const runningElsewhere = run?.status === "running" && !run.live;
  const good = latest.data?.lastSucceeded ?? null;
  const diagram = good?.run.result ?? null;
  const failed = run?.status === "failed";
  const cancelled = run?.status === "cancelled";
  const checkedOut = pr.status === "ready" && pr.worktreeStatus === "ready";

  const start = async () => {
    setStarting(true);
    setActionError(null);
    try {
      await runFlowDiagram(workspaceId, pr.id);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    if (!followId) return;
    setActionError(null);
    try {
      await cancelAgentRun(followId);
    } catch (e) {
      setActionError(e instanceof Error ? e.message : String(e));
    }
  };

  if (latest.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the flow diagram…" />
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Flow diagram</h2>
          {diagram && good && !running && (
            <span className="text-xs text-zinc-500">
              at {short(good.headSha)}
              {good.run.costUsd != null ? ` · $${good.run.costUsd.toFixed(2)}` : ""}
            </span>
          )}
          <span className="ml-auto flex gap-2">
            {running ? (
              <button
                type="button"
                onClick={() => void cancel()}
                className="rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
              >
                Cancel
              </button>
            ) : (
              !runningElsewhere && (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={starting || !checkedOut}
                  title={checkedOut ? undefined : "Waiting for the checkout"}
                  className="rounded bg-sky-700 px-3 py-1 text-xs text-white hover:bg-sky-600 disabled:opacity-50"
                >
                  {starting ? "Starting…" : run ? "Re-run" : "Generate diagram"}
                </button>
              )
            )}
          </span>
        </div>

        {actionError && (
          <p role="alert" className="text-xs text-red-400">
            {actionError}
          </p>
        )}
        {latest.error && <p className="text-xs text-red-400">{latest.error}</p>}

        {!run && (
          <p className="text-sm text-zinc-400">
            An agent finds the flow the change sits in, follows it up to what starts it and down to
            where it ends, and draws it as a flowchart with the changed steps marked.
          </p>
        )}

        {running && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-300">
            <Loader />
            <span>Tracing the flow…</span>
            {progress.activity && (
              <span className="min-w-0 truncate font-mono text-[11px] text-zinc-500">
                {progress.activity}
              </span>
            )}
          </div>
        )}

        {running && progress.error && <p className="text-xs text-red-400">{progress.error}</p>}

        {runningElsewhere && (
          <p className="text-sm text-zinc-400">
            A diagram is being drawn by another Yarvis window.{" "}
            <button
              type="button"
              onClick={() => void latest.refresh()}
              className="text-sky-400 hover:text-sky-300"
            >
              Check again
            </button>
          </p>
        )}

        {failed && (
          <div
            role="alert"
            className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300"
          >
            {diagram ? "The re-run failed" : "The last run failed"}:{" "}
            {run?.error ?? progress.error ?? "no reason given"}
            {diagram && good && (
              <span className="block text-xs text-red-300/80">
                Below is the last diagram, from {short(good.headSha)}.
              </span>
            )}
          </div>
        )}
        {cancelled && (
          <p className="text-sm text-zinc-500">
            The last run was cancelled.
            {diagram && good && ` Below is the last diagram, from ${short(good.headSha)}.`}
          </p>
        )}

        {diagram && good && !good.current && !running && (
          <p className="rounded-lg border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
            This diagram is for an older head; the pull request has moved to{" "}
            {short(latest.data?.headSha)}.
          </p>
        )}

        {diagram && !running && <FlowDiagram flow={diagram} />}
      </div>
    </div>
  );
}
