/**
 * What a headless Claude Code run reports while it works, as streamed to the UI
 * and kept for replay. Mirrored by `src/lib/agentRuns.ts` in the frontend.
 *
 * `subagentId` on `text` and `tool` is the id of the delegation that produced
 * it — the `subagent` event with the same `id` — or null for the main agent, so
 * a view can nest a subagent's work under it.
 */
export type AgentRunEvent =
  | { type: "status"; message: string }
  | { type: "text"; text: string; subagentId: string | null }
  | { type: "tool"; id: string; name: string; summary: string; subagentId: string | null }
  | {
      type: "subagent";
      phase: "start" | "stop";
      id: string;
      /** The subagent type, e.g. "general-purpose" or a plugin agent's name. */
      name: string;
      description: string;
      /** Set on `stop`: whether the delegation ended in an error. */
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
  /** Always the last event of a run. */
  | { type: "done"; status: AgentRunFinalStatus; error: string | null };

export type AgentRunStatus = "running" | AgentRunFinalStatus;
export type AgentRunFinalStatus = "succeeded" | "failed" | "cancelled";
