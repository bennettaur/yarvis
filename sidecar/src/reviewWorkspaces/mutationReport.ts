/**
 * What a mutation-testing pass found, and the verdict on it. The numbers and
 * the verdict are computed here from what the tests did, never taken from a
 * model.
 */

/**
 * - `killed`: the tests failed with the mutant in place.
 * - `survived`: they passed, running as many tests as the baseline did.
 * - `timeout`: they ran past their limit. Scored as killed, as Stryker does:
 *   a mutant that hangs the suite has been noticed.
 * - `error`: the run proved nothing either way (it didn't compile, ran no
 *   tests, ran a different number of tests, or the mutant was refused).
 * - `uncovered`: no test exercises the code. Not scored, but reported.
 * - `equivalent`: the planner judged it to behave like the original. Skipped.
 */
export type MutantOutcome =
  | "killed"
  | "survived"
  | "timeout"
  | "error"
  | "uncovered"
  | "equivalent";

export interface BaselineResult {
  id: string;
  argv: string[];
  testFiles: string[];
  passed: boolean;
  exitCode: number | null;
  durationMs: number;
  /** Tests the run reported; null when its output didn't say. */
  testCount: number | null;
  /** Why it can't be used, when it can't. */
  problem: string | null;
  excerpt: string;
}

export interface MutantResult {
  id: string;
  path: string;
  line: number;
  oldText: string;
  newText: string;
  description: string;
  rationale: string;
  testCommandId: string | null;
  testFiles: string[];
  outcome: MutantOutcome;
  durationMs: number | null;
  testCount: number | null;
  /** The failing output for a kill, the passing summary for a survivor, or why it proved nothing. */
  evidence: string;
}

export interface MutationExecution {
  baselines: BaselineResult[];
  positiveControl: MutantResult | null;
  mutants: MutantResult[];
  /** How many mutants the plan held, after the cap. */
  planned: number;
}

export type MutationVerdict = "strong" | "mixed" | "weak" | "inconclusive";

export interface MutationSummary {
  killed: number;
  survived: number;
  timeouts: number;
  errors: number;
  uncovered: number;
  equivalent: number;
  /** Killed, timed out and survived: the mutants that count. */
  valid: number;
  /** Of the valid mutants, the share the tests caught; null with none. */
  killRate: number | null;
  verdict: MutationVerdict;
  notes: string[];
}

export interface MutationFinding {
  mutantId: string;
  path: string;
  line: number;
  title: string;
  detail: string;
  severity: "high" | "medium" | "low";
  suggestion: string;
}

const STRONG_RATE = 0.9;
const STRONG_MIN_VALID = 5;
const WEAK_RATE = 0.6;
const MIN_VALID = 3;

export function summarize(
  execution: MutationExecution,
  state: { finished: boolean } = { finished: true },
): MutationSummary {
  const count = (outcome: MutantOutcome) =>
    execution.mutants.filter((m) => m.outcome === outcome).length;
  const killed = count("killed");
  const timeouts = count("timeout");
  const survived = count("survived");
  const valid = killed + timeouts + survived;
  const killRate = valid > 0 ? (killed + timeouts) / valid : null;
  const notes: string[] = [];

  const control = execution.positiveControl;
  const controlKilled = control?.outcome === "killed" || control?.outcome === "timeout";
  if (!control) {
    notes.push("No positive control ran, so it isn't known that the tests exercise this code.");
  } else if (!controlKilled) {
    notes.push(
      `The positive control was not caught (${control.outcome}): the tests may not be running the copy's code — an editable install or a build output pointing elsewhere, say.`,
    );
  }
  for (const baseline of execution.baselines) {
    if (!baseline.passed) {
      notes.push(
        `\`${baseline.argv.join(" ")}\` couldn't be used: ${baseline.problem ?? "it failed before any mutation"}.`,
      );
    }
  }
  if (timeouts > 0) notes.push("Timeouts count as kills, as Stryker scores them.");
  if (!state.finished) {
    notes.push(
      `Stopped after ${execution.mutants.length} of ${execution.planned} mutants; these are partial results.`,
    );
  }

  let verdict: MutationVerdict;
  if (!controlKilled || valid < MIN_VALID || killRate === null) {
    verdict = "inconclusive";
    if (controlKilled && valid < MIN_VALID) {
      notes.push(
        `Only ${valid} mutants gave a result; at least ${MIN_VALID} are needed for a verdict.`,
      );
    }
  } else if (killRate >= STRONG_RATE && valid >= STRONG_MIN_VALID) {
    verdict = "strong";
  } else if (killRate < WEAK_RATE) {
    verdict = "weak";
  } else {
    verdict = "mixed";
  }

  return {
    killed,
    survived,
    timeouts,
    errors: count("error"),
    uncovered: count("uncovered"),
    equivalent: count("equivalent"),
    valid,
    killRate,
    verdict,
    notes,
  };
}
