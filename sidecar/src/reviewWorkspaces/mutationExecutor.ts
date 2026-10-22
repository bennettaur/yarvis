/**
 * Runs a mutation plan in the scratch copy: no model is involved from here.
 * Baselines first, one per test command; then each command's positive
 * control, which its tests must kill for anything they say to count; then
 * each mutant, applied, tested and reverted in turn. Each result is handed to
 * `onUpdate` as soon as it exists, so a run that is cancelled or cut off keeps
 * what it found.
 */

import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import {
  CONTROL_ID_PREFIX,
  type MutationPlan,
  type PlannedEdit,
  prepareEdit,
  withEdit,
} from "./mutants.ts";
import type {
  BaselineResult,
  MutantOutcome,
  MutantResult,
  MutationExecution,
} from "./mutationReport.ts";
import { parseTestCounts, resolveTestCommand, testCommandProblem } from "./testCommands.ts";
import {
  checkSandbox,
  killStrays,
  makeRunTempDir,
  runSandboxed,
  type SandboxedCommand,
  type SandboxedRun,
  type SandboxRunner,
} from "./testSandbox.ts";

/** A mutant's tests get three times the baseline, and never less than this. */
const MIN_MUTANT_TIMEOUT_MS = 30_000;
const EXCERPT_CHARS = 1_500;

export type ExecutionEvent =
  | { type: "phase"; phase: "baseline" | "control" | "mutants" }
  | { type: "baseline"; result: BaselineResult }
  | { type: "mutant"; result: MutantResult; index: number; total: number; control: boolean };

export interface ExecutorDeps {
  runner?: SandboxRunner;
  /** Replaced in tests whose runner is a fake. */
  checkSandbox?: typeof checkSandbox;
  /** Kills what a command left running in the copy or temp folder; returns the pids it killed. */
  killStrays?: (roots: string[]) => Promise<number[]>;
  makeTempDir?: () => string;
}

export interface ExecutionInput {
  copyRoot: string;
  plan: MutationPlan;
  changedPaths: ReadonlySet<string>;
  changedRanges?: ReadonlyMap<string, [number, number][]>;
  maxMutants: number;
  /** The longest any one test command may run. */
  timeoutCapMs: number;
  signal: AbortSignal;
  /** Where the sandbox keeps the user's other checkouts and which ports it closes. */
  sandbox?: SandboxedCommand["sandbox"];
  onEvent: (event: ExecutionEvent) => void;
  onUpdate: (execution: MutationExecution) => Promise<void>;
  /** Told each test command's process group, so a crash can't orphan it. */
  onSpawn?: (pgid: number) => void;
}

function excerpt(output: string): string {
  return redactSecrets(output.trim()).slice(-EXCERPT_CHARS);
}

function mutantTimeout(baseline: BaselineResult, capMs: number): number {
  return Math.min(capMs, Math.max(MIN_MUTANT_TIMEOUT_MS, baseline.durationMs * 3));
}

/**
 * How a mutant's test run is scored, from the tests' own counts:
 * killed when they exit non-zero with at least one failure; survived when they
 * exit zero with no failures and as many tests as the baseline ran; anything
 * else proves nothing either way.
 */
export function classify(
  run: SandboxedRun,
  argv: string[],
  baselineCount: number | null,
): { outcome: MutantOutcome; testCount: number | null; evidence: string } {
  const counts = parseTestCounts(argv, run.output);
  const testCount = counts?.total ?? null;
  const tail = excerpt(run.output);
  if (run.timedOut) {
    return { outcome: "timeout", testCount, evidence: "The tests ran past their time limit." };
  }
  if (run.exitCode !== 0 && counts && counts.failed > 0) {
    return { outcome: "killed", testCount, evidence: tail };
  }
  if (run.exitCode === 0 && counts && counts.failed === 0 && counts.total > 0) {
    if (counts.total === baselineCount) return { outcome: "survived", testCount, evidence: tail };
    return {
      outcome: "error",
      testCount,
      evidence: `The tests passed but ran ${counts.total} tests, against ${baselineCount} at baseline.\n${tail}`,
    };
  }
  const why =
    counts === null
      ? `exited with code ${run.exitCode} and didn't say how many tests ran`
      : `exited with code ${run.exitCode} after ${counts.total} tests with ${counts.failed} failures`;
  return {
    outcome: "error",
    testCount,
    evidence: `The tests ${why} (the mutant may not compile).\n${tail}`,
  };
}

/** The problem with a baseline run, or null when it can be measured against. */
function baselineProblem(run: SandboxedRun, argv: string[]): string | null {
  const counts = parseTestCounts(argv, run.output);
  if (run.timedOut) return "it timed out";
  if (counts === null)
    return `it exited with code ${run.exitCode} and didn't say how many tests ran`;
  if (counts.total === 0) return "it ran no tests";
  if (counts.failed > 0) return `${counts.failed} tests failed before any mutation`;
  if (run.exitCode !== 0) return `it exited with code ${run.exitCode} with no failing test`;
  return null;
}

type RunnableEdit = PlannedEdit & { id: string; rationale: string; testFiles: string[] };

export async function executeMutationPlan(
  input: ExecutionInput,
  deps: ExecutorDeps = {},
): Promise<MutationExecution> {
  const runner = deps.runner ?? runSandboxed;
  const strays = deps.killStrays ?? killStrays;
  const tempDir = (deps.makeTempDir ?? makeRunTempDir)();
  // Equivalents are reported but don't use up the cap.
  const equivalents = input.plan.mutants.filter((m) => m.likelyEquivalent);
  const scored = input.plan.mutants.filter((m) => !m.likelyEquivalent).slice(0, input.maxMutants);
  const execution: MutationExecution = {
    baselines: [],
    positiveControls: [],
    mutants: [],
    planned: equivalents.length + scored.length,
  };
  const commands = new Map(input.plan.testCommands.map((c) => [c.id, c]));
  const baselines = new Map<string, BaselineResult>();
  const resolved = new Map<string, string[]>();
  /** Commands whose positive control their tests killed: the only ones that count. */
  const proven = new Set<string>();
  const context = {
    copyRoot: input.copyRoot,
    changedPaths: input.changedPaths,
    ...(input.changedRanges ? { changedRanges: input.changedRanges } : {}),
  };
  /**
   * Makes sure nothing a test started is still at work in the copy, before the
   * sidecar writes there again: kills it, then looks again. Throws when
   * something won't die, since a revert written under it can't be trusted.
   */
  const cleanUp = async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const killed = await strays([input.copyRoot, tempDir]);
      if (killed.length === 0) return;
      console.log(`[mutation-testing] killed ${killed.length} processes the tests left behind`);
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    throw new Error("processes the tests started kept running in the copy");
  };

  /** Runs one test command; with `settle`, cleans up after it (a mutant's revert does that itself). */
  const run = async (argv: string[], timeoutMs: number, settle = true) => {
    try {
      return await runner({
        argv,
        cwd: input.copyRoot,
        tempDir,
        timeoutMs,
        signal: input.signal,
        sandbox: input.sandbox,
        ...(input.onSpawn ? { onSpawn: input.onSpawn } : {}),
      });
    } finally {
      if (settle) await cleanUp();
    }
  };

  const base = (edit: RunnableEdit) => ({
    id: edit.id,
    path: edit.path,
    line: edit.line,
    oldText: edit.oldText,
    newText: edit.newText,
    description: edit.description,
    rationale: edit.rationale,
    testCommandId: edit.testCommandId,
    testFiles: edit.testFiles,
    durationMs: null,
    testCount: null,
  });
  const result = (edit: RunnableEdit, outcome: MutantOutcome, evidence: string): MutantResult => ({
    ...base(edit),
    outcome,
    evidence,
  });

  /** Applies an edit, runs one command's tests against it, reverts. Null when cancelled. */
  const tryEdit = async (edit: RunnableEdit, commandId: string): Promise<MutantResult | null> => {
    const baseline = baselines.get(commandId);
    const argv = resolved.get(commandId);
    if (!baseline || !argv) {
      return result(edit, "error", `Rejected: no usable test command \`${commandId}\`.`);
    }
    const prepared = prepareEdit(edit, context);
    if ("refused" in prepared) return result(edit, "error", `Rejected: ${prepared.refused}.`);
    const ran = await withEdit(
      prepared,
      () => run(argv, mutantTimeout(baseline, input.timeoutCapMs), false),
      cleanUp,
    );
    if (ran.aborted) return null;
    const scoredRun = classify(ran, commands.get(commandId)?.argv ?? argv, baseline.testCount);
    return {
      ...base(edit),
      outcome: scoredRun.outcome,
      durationMs: ran.durationMs,
      testCount: scoredRun.testCount,
      evidence: scoredRun.evidence,
    };
  };

  try {
    await (deps.checkSandbox ?? checkSandbox)(
      runner,
      { cwd: input.copyRoot, tempDir, outside: dirname(input.copyRoot), signal: input.signal },
      input.sandbox,
    );

    input.onEvent({ type: "phase", phase: "baseline" });
    for (const command of input.plan.testCommands) {
      if (input.signal.aborted) return execution;
      const problem = testCommandProblem(command.argv);
      const resolution = problem ? null : resolveTestCommand(command.argv, input.copyRoot);
      let baseline: BaselineResult;
      const unusable =
        problem ?? (resolution && "problem" in resolution ? resolution.problem : null);
      if (unusable || !resolution || "problem" in resolution) {
        baseline = {
          ...command,
          passed: false,
          exitCode: null,
          durationMs: 0,
          testCount: null,
          problem: unusable ?? "it can't be run",
          excerpt: "",
        };
      } else {
        const ran = await run(resolution.argv, input.timeoutCapMs);
        if (ran.aborted) return execution;
        const why = baselineProblem(ran, command.argv);
        baseline = {
          ...command,
          passed: why === null,
          exitCode: ran.exitCode,
          durationMs: ran.durationMs,
          testCount: parseTestCounts(command.argv, ran.output)?.total ?? null,
          problem: why,
          excerpt: excerpt(ran.output),
        };
        if (baseline.passed) resolved.set(command.id, resolution.argv);
      }
      baselines.set(command.id, baseline);
      execution.baselines.push(baseline);
      input.onEvent({ type: "baseline", result: baseline });
      await input.onUpdate(execution);
    }

    input.onEvent({ type: "phase", phase: "control" });
    const controlled = new Set<string>();
    for (const [index, control] of input.plan.positiveControls.entries()) {
      if (input.signal.aborted) return execution;
      const edit: RunnableEdit = {
        ...control,
        id: `${CONTROL_ID_PREFIX}${control.testCommandId ?? index}`,
        rationale: "",
        testFiles: [],
      };
      let outcome: MutantResult | null;
      if (control.testCommandId === null || !commands.has(control.testCommandId)) {
        outcome = result(edit, "error", "Rejected: the control names no test command in the plan.");
      } else if (controlled.has(control.testCommandId)) {
        outcome = result(edit, "error", "Rejected: that command already has a positive control.");
      } else if (!baselines.get(control.testCommandId)?.passed) {
        outcome = result(edit, "error", "Its tests couldn't run cleanly before mutation.");
      } else {
        controlled.add(control.testCommandId);
        outcome = await tryEdit(edit, control.testCommandId);
        if (!outcome) return execution;
        if (outcome.outcome === "killed" || outcome.outcome === "timeout") {
          proven.add(control.testCommandId);
        }
      }
      execution.positiveControls.push(outcome);
      input.onEvent({
        type: "mutant",
        result: outcome,
        index,
        total: input.plan.positiveControls.length,
        control: true,
      });
      await input.onUpdate(execution);
    }

    input.onEvent({ type: "phase", phase: "mutants" });
    const ordered = [...scored, ...equivalents];
    for (const [index, mutant] of ordered.entries()) {
      if (input.signal.aborted) return execution;
      let outcome: MutantResult | null;
      if (mutant.likelyEquivalent) {
        outcome = result(
          mutant,
          "equivalent",
          "The planner judged this mutant to behave like the original; it wasn't run.",
        );
      } else if (mutant.testCommandId === null) {
        outcome = await checkUncovered(mutant);
        if (!outcome) return execution;
      } else if (!commands.has(mutant.testCommandId)) {
        outcome = result(
          mutant,
          "error",
          `Rejected: no test command \`${mutant.testCommandId}\` in the plan.`,
        );
      } else if (!baselines.get(mutant.testCommandId)?.passed) {
        outcome = result(
          mutant,
          "error",
          `Its tests couldn't run cleanly before mutation: ${baselines.get(mutant.testCommandId)?.problem}.`,
        );
      } else if (!proven.has(mutant.testCommandId)) {
        outcome = result(
          mutant,
          "error",
          "Its tests didn't catch their positive control, so they can't be shown to run this code.",
        );
      } else {
        outcome = await tryEdit(mutant, mutant.testCommandId);
        if (!outcome) return execution;
      }
      execution.mutants.push(outcome);
      input.onEvent({
        type: "mutant",
        result: outcome,
        index,
        total: ordered.length,
        control: false,
      });
      await input.onUpdate(execution);
    }
    return execution;
  } finally {
    try {
      await cleanUp();
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }

  /**
   * A mutant the planner found no test for, run against every command whose
   * control proved it: if one of them catches it, it was covered after all.
   * Null when cancelled.
   */
  async function checkUncovered(mutant: RunnableEdit): Promise<MutantResult | null> {
    const candidates = [...proven];
    if (candidates.length === 0) {
      return result(
        mutant,
        "uncovered",
        "No test exercises this code (no proven test command to check it against).",
      );
    }
    let last: MutantResult | null = null;
    for (const commandId of candidates) {
      const tried = await tryEdit({ ...mutant, testCommandId: commandId }, commandId);
      if (!tried) return null;
      if (tried.outcome === "killed" || tried.outcome === "timeout") {
        return {
          ...tried,
          testCommandId: null,
          evidence: `The planner found no test for this, but \`${commandId}\` caught it.\n${tried.evidence}`,
        };
      }
      if (tried.outcome === "error" && tried.evidence.startsWith("Rejected")) return tried;
      last = tried;
    }
    return {
      ...(last ?? result(mutant, "uncovered", "")),
      testCommandId: null,
      outcome: "uncovered",
      evidence: `No test caught it: every test command passed with the mutant in place.\n${last?.evidence ?? ""}`,
    };
  }
}
