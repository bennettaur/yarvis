import { ensureOk, sidecarFetch, streamSSE } from "./api";

/**
 * Client for headless Claude Code runs (a verification report, a
 * mutation-testing pass). A feature starts its run through its own route and
 * gets the run's id back; everything after that — following it live, reading
 * the outcome, stopping it — is the same for every kind and lives here.
 */

/**
 * What a run reports while it works. Mirrors the sidecar's `AgentRunEvent`
 * (`sidecar/src/agentRuns/events.ts`).
 *
 * `subagentId` on `text` and `tool` is the id of the delegation that produced
 * it — the `subagent` event with the same `id` — or null for the main agent, so
 * a view can nest a subagent's work under it.
 *
 * A run ends with exactly one of `result` (it succeeded) or `error` (it failed),
 * unless it was cancelled, and then `done`.
 */
export type AgentRunEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string; subagentId: string | null }
  | {
      type: "tool";
      id: string;
      name: string;
      summary: string;
      subagentId: string | null;
      /** A file tool's whole path, as given; `summary` shortens and caps it. */
      path?: string;
    }
  | {
      type: "subagent";
      phase: "start" | "stop";
      id: string;
      /** The subagent type, e.g. "general-purpose" or a plugin agent's name. */
      name: string;
      description: string;
      /** Set on `stop`: whether the delegation ended in an error or never ended. */
      failed?: boolean;
    }
  | {
      type: "result";
      /** The structured output, validated against the run's schema; null without one. */
      output: unknown;
      /** The final answer as text. */
      text: string;
      costUsd: number | null;
      durationMs: number | null;
      sessionId: string | null;
    }
  | { type: "error"; message: string }
  /** Always the last event of a run. Why a failed run failed is the `error` before it. */
  | { type: "done"; status: AgentRunFinalStatus };

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
  /** Claude Code's figure, or an estimate from token usage when it never gave one. */
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
    let frame: AgentRunEvent | { type: "ping" };
    try {
      frame = JSON.parse(data);
    } catch (e) {
      // One unreadable frame shouldn't end the view of a run that is still going.
      console.warn("[agent-runs] dropped unparseable stream frame:", e);
      continue;
    }
    // Pings only keep an idle connection open.
    if (frame.type !== "ping") yield frame;
  }
}

/** Asks the run to stop. It ends with a `done` event of status `cancelled`. */
export async function cancelAgentRun(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/agent-runs/${encodeURIComponent(id)}/cancel`, {
    method: "POST",
  });
  await ensureOk(res, "cancel agent run");
}
