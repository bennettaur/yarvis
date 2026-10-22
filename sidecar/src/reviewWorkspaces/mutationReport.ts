/**
 * What a mutation-testing pass found, and the verdict on it. The numbers and
 * the verdict are computed here from what the tests did, never taken from a
 * model.
 *
 * Every string in these types that came from the PR, its tests or a model —
 * paths, code, test output, evidence, findings — is untrusted text. It is
 * stored as given (redacted for credential shapes) and must be shown as plain
 * text: never rendered as HTML or markdown, never fed to a prompt unfenced.
 */

/**
 * - `killed`: the tests exited non-zero with at least one failing test.
 * - `survived`: they exited zero with no failures, running as many tests as
 *   the baseline did.
 * - `timeout`: they ran past their limit. Scored as killed, as Stryker does:
 *   a mutant that hangs the suite has been noticed.
 * - `error`: the run proved nothing either way (it didn't compile, ran a
 *   different number of tests, the mutant was refused, or its tests didn't
 *   catch their positive control).
 * - `uncovered`: no test caught it, run against every proven test command,
 *   and the planner found no test that reaches it. Not scored, but reported.
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
  /** Untrusted test output. */
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
  /** Untrusted: the failing output for a kill, the passing summary for a survivor, or why it proved nothing. */
  evidence: string;
}

export interface MutationExecution {
  baselines: BaselineResult[];
  /** One per test command: a blatant mutant its tests must kill for its results to count. */
  positiveControls: MutantResult[];
  mutants: MutantResult[];
  /** How many mutants the plan held after the cap, equivalents included. */
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

/** A model's explanation of a survivor. Every text field is untrusted; show it as plain text. */
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
/**
 * Past this share of the scored mutants being uncovered, the verdict can be no
 * better than mixed: the tests that exist may be good, but a quarter of the
 * change has none.
 */
const UNCOVERED_CAP_SHARE = 0.25;

const isKill = (outcome: MutantOutcome | undefined) =>
  outcome === "killed" || outcome === "timeout";

export function summarize(execution: MutationExecution): MutationSummary {
  const count = (outcome: MutantOutcome) =>
    execution.mutants.filter((m) => m.outcome === outcome).length;
  const killed = count("killed");
  const timeouts = count("timeout");
  const survived = count("survived");
  const uncovered = count("uncovered");
  const equivalent = count("equivalent");
  const valid = killed + timeouts + survived;
  const killRate = valid > 0 ? (killed + timeouts) / valid : null;
  const notes: string[] = [];

  const controls = execution.positiveControls;
  const proven = controls.filter((c) => isKill(c.outcome));
  if (controls.length === 0) {
    notes.push("No positive control ran, so it isn't known that the tests exercise this code.");
  }
  for (const control of controls) {
    if (!isKill(control.outcome)) {
      notes.push(
        `The positive control for \`${control.testCommandId ?? "?"}\` was not caught (${control.outcome}): those tests may not be running the copy's code — an editable install or a build output pointing elsewhere, say — so their mutants weren't scored.`,
      );
    }
  }
  for (const baseline of execution.baselines) {
    if (!baseline.passed) {
      notes.push(
        `\`${baseline.argv.join(" ")}\` couldn't be used: ${baseline.problem ?? "it failed"}.`,
      );
    }
  }
  if (timeouts > 0) notes.push("Timeouts count as kills, as Stryker scores them.");
  if (execution.mutants.length < execution.planned) {
    notes.push(
      `Stopped after ${execution.mutants.length} of ${execution.planned} mutants; these are partial results.`,
    );
  }

  let verdict: MutationVerdict;
  if (proven.length === 0 || valid < MIN_VALID || killRate === null) {
    verdict = "inconclusive";
    if (proven.length > 0 && valid < MIN_VALID) {
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
  const scoredPlanned = execution.planned - equivalent;
  if (
    verdict === "strong" &&
    scoredPlanned > 0 &&
    uncovered / scoredPlanned > UNCOVERED_CAP_SHARE
  ) {
    verdict = "mixed";
    notes.push(
      `${uncovered} of ${scoredPlanned} mutants hit code no test reaches, so the verdict is held at mixed.`,
    );
  }

  return {
    killed,
    survived,
    timeouts,
    errors: count("error"),
    uncovered,
    equivalent,
    valid,
    killRate,
    verdict,
    notes,
  };
}
