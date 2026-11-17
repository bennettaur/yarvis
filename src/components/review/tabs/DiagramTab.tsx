import { useEffect } from "react";
import { Loader } from "../../ai-elements/loader";
import LoadingIndicator from "../../LoadingIndicator";
import FlowDiagram from "./FlowDiagram";
import { useVerificationChecklist } from "./reviewData";
import type { TabContext } from "./types";

const short = (sha: string | null | undefined) => (sha ? sha.slice(0, 7) : "?");

/** How often the checklist is re-read while the diagram's check runs. */
const POLL_MS = 3000;

/**
 * The PR's flow diagram, on its own: the newest answer of the verification
 * checklist's flow check. It is run from the checklist, which this tab opens.
 */
export default function DiagramTab({ ctx }: { ctx: TabContext }) {
  const { workspaceId, pr } = ctx;
  const checklist = useVerificationChecklist(workspaceId, pr.id);
  const item = checklist.data?.items.find((i) => i.section === "flow") ?? null;
  const latest = item?.latest ?? null;
  const result = item?.result ?? null;
  const diagram = result ? (checklist.data?.report?.flow ?? null) : null;
  const running = latest?.status === "running";
  // The newest run didn't answer, so the diagram shown (if any) is an older one.
  const failed = latest?.status === "failed";
  const cancelled = latest?.status === "cancelled";

  const { refresh } = checklist;
  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [running, refresh]);

  if (checklist.loading) {
    return (
      <div className="p-4">
        <LoadingIndicator label="Loading the flow diagram…" />
      </div>
    );
  }

  const lastDiagramNote =
    diagram && result && ` Below is the last diagram, from ${short(result.headSha)}.`;

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl space-y-4 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-sm font-semibold text-zinc-200">Flow diagram</h2>
          {diagram && result && !running && (
            <span className="text-xs text-zinc-500">
              at {short(result.headSha)}
              {result.costUsd != null ? ` · $${result.costUsd.toFixed(2)}` : ""}
            </span>
          )}
          <button
            type="button"
            onClick={() => ctx.openTab({ kind: "verification", prId: pr.id })}
            className="ml-auto rounded border border-zinc-700 px-3 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Open checklist
          </button>
        </div>

        {checklist.error && <p className="text-xs text-red-400">{checklist.error}</p>}

        {!latest && (
          <p className="text-sm text-zinc-400">
            No diagram yet. Run <b>Flow diagram</b> from the verification checklist: an agent finds
            the flow the change sits in, follows it up to what starts it and down to where it ends,
            and draws it as a flowchart with the changed steps marked.
          </p>
        )}

        {running && (
          <div className="flex items-center gap-2 rounded-lg border border-zinc-800 bg-zinc-900/50 p-3 text-sm text-zinc-300">
            <Loader />
            <span>
              {latest.live ? "Tracing the flow…" : "Being drawn by another Yarvis instance…"}
            </span>
          </div>
        )}

        {failed && (
          <div
            role="alert"
            className="rounded-lg border border-red-900 bg-red-950/30 p-3 text-sm text-red-300"
          >
            The last run failed: {latest.error ?? "no reason given"}
            {lastDiagramNote && (
              <span className="block text-xs text-red-300/80">{lastDiagramNote.trim()}</span>
            )}
          </div>
        )}
        {cancelled && (
          <p className="text-sm text-zinc-500">
            The last run was cancelled.
            {lastDiagramNote}
          </p>
        )}

        {diagram && result && !result.current && !running && (
          <p className="rounded-lg border border-amber-800 bg-amber-950/30 p-2 text-xs text-amber-200">
            This diagram is for an older head; the pull request has moved to{" "}
            {short(checklist.data?.headSha)}.
          </p>
        )}

        {diagram && !running && <FlowDiagram flow={diagram} />}
      </div>
    </div>
  );
}
