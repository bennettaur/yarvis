import type { AgentRunStatus } from "../agentRuns";
import { ensureOk, sidecarFetch } from "../api";

/**
 * Client for a review PR's flow diagram: starting a run, and reading the
 * latest. Following a run live goes through `lib/agentRuns`, like any other
 * headless Claude Code run.
 */

/** A Mermaid flowchart of the flow the change sits in. `mermaid` is empty when there was none to draw. */
export interface FlowDiagram {
  title: string;
  explanation: string;
  mermaid: string;
  /** The agent's diagram was over the size limit, so it was dropped. */
  tooLarge?: boolean;
}

/** A flow diagram run as the route returns it. */
export interface FlowDiagramRun {
  id: string;
  status: AgentRunStatus;
  /** The diagram, once the run has succeeded. */
  result: FlowDiagram | null;
  error: string | null;
  costUsd: number | null;
  meta: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
  /** Whether this sidecar is running it, so its events can be followed live. */
  live: boolean;
}

/** Mirrors the sidecar's `LatestFlowDiagram`. */
export interface LatestFlowDiagram {
  run: FlowDiagramRun | null;
  /** The PR's head now. */
  headSha: string | null;
  /** True when the run was made against that head. */
  current: boolean;
  /** The newest run that finished with a diagram, so a failed re-run doesn't hide the last one. */
  lastSucceeded: {
    run: Omit<FlowDiagramRun, "live">;
    headSha: string | null;
    current: boolean;
  } | null;
}

const path = (workspaceId: string, prId: string) =>
  `/api/review-workspaces/${workspaceId}/prs/${prId}/flow-diagram`;

export async function latestFlowDiagram(
  workspaceId: string,
  prId: string,
): Promise<LatestFlowDiagram> {
  const res = await sidecarFetch(path(workspaceId, prId));
  await ensureOk(res, "read flow diagram");
  return res.json();
}

/** Starts a diagram, or answers with the run already going for this PR (`existing`). */
export async function startFlowDiagram(
  workspaceId: string,
  prId: string,
): Promise<{ runId: string; existing: boolean }> {
  const res = await sidecarFetch(path(workspaceId, prId), { method: "POST" });
  await ensureOk(res, "start flow diagram");
  return res.json();
}
