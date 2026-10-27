import type { AgentRunEvent, AgentRunFinalStatus } from "../../../lib/agentRuns";

/**
 * A verification run's progress as its events tell it: which of the checks
 * are running, which are done, and what each is doing right now. The checks
 * are the plugin's subagents, so their start and stop events are the
 * progress; tool calls say what each is reading.
 */

export type CheckState = "waiting" | "running" | "done" | "failed";

export interface CheckProgress {
  /** The plugin agent's name, without the plugin prefix. */
  agent: string;
  label: string;
  state: CheckState;
  /** The latest tool call it made, e.g. "Read src/a.ts". */
  activity: string | null;
}

export interface RunProgress {
  checks: CheckProgress[];
  /** The latest thing the coordinating agent said or did. */
  activity: string | null;
  finished: AgentRunFinalStatus | null;
  error: string | null;
  /** Which check each running delegation is, by its event id. */
  delegations: Record<string, string>;
}

/** The checks the report's skill fans out, in the order the report shows them. */
export const VERIFICATION_AGENTS: readonly { agent: string; label: string }[] = [
  { agent: "change-summary", label: "Summary and must-read files" },
  { agent: "risk-reviewer", label: "Risk" },
  { agent: "completeness-reviewer", label: "Completeness" },
  { agent: "test-reviewer", label: "Test quality" },
  { agent: "complexity-reviewer", label: "Complexity" },
  { agent: "performance-reviewer", label: "Performance" },
  { agent: "comment-reviewer", label: "Comment quality" },
  { agent: "observability-reviewer", label: "Observability" },
  { agent: "quality-reviewer", label: "Code quality" },
];

export function initialProgress(): RunProgress {
  return {
    checks: VERIFICATION_AGENTS.map((a) => ({ ...a, state: "waiting", activity: null })),
    activity: null,
    finished: null,
    error: null,
    delegations: {},
  };
}

/** "yarvis-review:risk-reviewer" → "risk-reviewer". */
const agentName = (name: string) => name.slice(name.lastIndexOf(":") + 1);

function updateCheck(
  progress: RunProgress,
  agent: string,
  change: Partial<CheckProgress>,
): CheckProgress[] {
  return progress.checks.map((c) => (c.agent === agent ? { ...c, ...change } : c));
}

/** One event applied to the progress so far. */
export function reduceProgress(progress: RunProgress, event: AgentRunEvent): RunProgress {
  switch (event.type) {
    case "subagent": {
      const agent = agentName(event.name);
      if (!progress.checks.some((c) => c.agent === agent)) return progress;
      if (event.phase === "start") {
        return {
          ...progress,
          delegations: { ...progress.delegations, [event.id]: agent },
          // A retried check starts again from nothing.
          checks: updateCheck(progress, agent, { state: "running", activity: null }),
        };
      }
      return {
        ...progress,
        checks: updateCheck(progress, agent, {
          state: event.failed ? "failed" : "done",
          activity: null,
        }),
      };
    }
    case "tool": {
      const summary = event.summary ? `${event.name} ${event.summary}` : event.name;
      const agent = event.subagentId ? progress.delegations[event.subagentId] : undefined;
      if (agent)
        return { ...progress, checks: updateCheck(progress, agent, { activity: summary }) };
      return { ...progress, activity: summary };
    }
    case "status":
      return { ...progress, activity: event.message };
    case "error":
      return { ...progress, error: event.message };
    case "done":
      return { ...progress, finished: event.status };
    default:
      return progress;
  }
}
