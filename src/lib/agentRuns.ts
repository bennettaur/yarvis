import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Client for headless Claude Code runs (a verification report, a
 * mutation-testing pass). A feature starts its run through its own route and
 * gets the run's id back; everything after that — following it live, reading
 * the outcome, stopping it — is the same for every kind and lives here.
 */

/** Mirrors the sidecar's `AgentRunEvent` (`sidecar/src/agentRuns/events.ts`). */
export type AgentRunEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string; subagentId: string | null }
  | { type: "tool"; id: string; name: string; summary: string; subagentId: string | null }
  | {
      type: "subagent";
      phase: "start" | "stop";
      id: string;
      name: string;
      description: string;
      failed?: boolean;
    }
  | {
      type: "result";
      output: unknown;
      text: string;
      costUsd: number | null;
      durationMs: number | null;
      sessionId: string | null;
    }
  | { type: "error"; message: string }
  | { type: "done"; status: AgentRunFinalStatus; error: string | null };

export type AgentRunFinalStatus = "succeeded" | "failed" | "cancelled";
export type AgentRunStatus = "running" | AgentRunFinalStatus;

export interface AgentRun {
  id: string;
  kind: string;
  targetKey: string;
  status: AgentRunStatus;
  /** The validated structured output, once the run has succeeded. */
  result: unknown;
  error: string | null;
  costUsd: number | null;
  sessionId: string | null;
  meta: Record<string, unknown>;
  startedAt: string;
  finishedAt: string | null;
}

export async function getAgentRun(id: string): Promise<AgentRun & { live: boolean }> {
  const res = await sidecarFetch(`/api/agent-runs/${encodeURIComponent(id)}`);
  await ensureOk(res, "agent run");
  return res.json();
}

/** The latest runs, newest first, narrowed to a kind and/or a target (a PR's `refKey`). */
export async function listAgentRuns(
  filter: { kind?: string; target?: string; limit?: number } = {},
): Promise<AgentRun[]> {
  const params = new URLSearchParams();
  if (filter.kind) params.set("kind", filter.kind);
  if (filter.target) params.set("target", filter.target);
  if (filter.limit !== undefined) params.set("limit", String(filter.limit));
  const query = params.toString();
  const res = await sidecarFetch(`/api/agent-runs${query ? `?${query}` : ""}`);
  await ensureOk(res, "agent runs");
  return res.json();
}

/**
 * Follows a run: what it has done so far, then each event as it happens, ending
 * after the `done` event. `signal` stops following; the run carries on.
 */
export async function* streamAgentRun(
  id: string,
  signal?: AbortSignal,
): AsyncGenerator<AgentRunEvent> {
  for await (const data of streamSSE(`/api/agent-runs/${encodeURIComponent(id)}/events`, {
    signal,
  })) {
    try {
      yield JSON.parse(data) as AgentRunEvent;
    } catch (e) {
      // One unreadable frame shouldn't end the view of a run that is still going.
      console.warn("[agent-runs] dropped unparseable stream frame:", e);
    }
  }
}

/** Asks the run to stop. It ends with a `done` event of status `cancelled`. */
export async function cancelAgentRun(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  await ensureOk(res, "cancel agent run");
}
