import type {
  BaselineResult,
  MutantResult,
  MutationPhase,
  MutationProgressEvent,
  MutationRunStatus,
} from "../../../lib/reviewWorkspaces/mutation";

/** A pass as it is going: where it is, and each result as it lands. */
export interface MutationProgress {
  phase: MutationPhase;
  baselines: BaselineResult[];
  controls: MutantResult[];
  mutants: MutantResult[];
  /** How many mutants the run will try, once it has said. */
  total: number | null;
  /** What the planning or explaining agent is doing now. */
  activity: string | null;
  error: string | null;
  /** Set by the pass's last event. */
  finished: MutationRunStatus | null;
  /** The stream closed or failed, with or without that last event. */
  streamEnded: boolean;
}

export const PHASE_LABEL: Record<MutationPhase, string> = {
  copying: "Copying the checkout",
  planning: "Planning mutants",
  baseline: "Running the tests as they are",
  control: "Checking the tests notice a blatant change",
  mutants: "Testing mutants",
  explaining: "Explaining survivors",
  done: "Done",
};

/** The phases in order, for the progress list; `done` isn't a step. */
export const PHASES: MutationPhase[] = [
  "copying",
  "planning",
  "baseline",
  "control",
  "mutants",
  "explaining",
];

export function initialMutationProgress(): MutationProgress {
  return {
    phase: "copying",
    baselines: [],
    controls: [],
    mutants: [],
    total: null,
    activity: null,
    error: null,
    finished: null,
    streamEnded: false,
  };
}

/** Results land once each; a replayed stream mustn't count one twice. */
function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const at = list.findIndex((x) => x.id === item.id);
  return at < 0 ? [...list, item] : list.map((x, i) => (i === at ? item : x));
}

/**
 * Folds one progress event into the state. Pure, so the order and replay rules
 * are tested without a stream.
 */
export function reduceMutationProgress(
  state: MutationProgress,
  event: MutationProgressEvent,
): MutationProgress {
  switch (event.type) {
    case "phase":
      return { ...state, phase: event.phase, activity: null };
    case "agent": {
      const e = event.event;
      const activity =
        e.type === "tool"
          ? `${e.name} ${e.summary}`.trim()
          : e.type === "status"
            ? e.message
            : state.activity;
      return { ...state, activity };
    }
    case "baseline":
      return { ...state, baselines: upsert(state.baselines, event.result) };
    case "mutant":
      return event.control
        ? { ...state, controls: upsert(state.controls, event.result) }
        : { ...state, mutants: upsert(state.mutants, event.result), total: event.total };
    case "error":
      return { ...state, error: event.message };
    case "done":
      return { ...state, phase: "done", finished: event.status, activity: null };
    case "ping":
      return state;
  }
}
