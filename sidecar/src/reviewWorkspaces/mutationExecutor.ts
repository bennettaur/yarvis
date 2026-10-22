/**
 * Runs a mutation plan in the scratch copy: no model is involved from here.
 * Baselines first, one per test command; then the positive control, which the
 * tests must kill for the rest to mean anything; then each mutant, applied,
 * tested and reverted in turn. Each result is handed to `onUpdate` as soon as
 * it exists, so a run that is cancelled or cut off keeps what it found.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { redactSecrets } from "../llm/errors.ts";
import { type MutationPlan, type PlannedEdit, prepareEdit, withEdit } from "./mutants.ts";
import type {
  BaselineResult,
  MutantOutcome,
  MutantResult,
  MutationExecution,
} from "./mutationReport.ts";
import { parseTestCounts, testCommandProblem } from "./testCommands.ts";
import {
  checkSandbox,
  runSandboxed,
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
}

export interface ExecutionInput {
  copyRoot: string;
  plan: MutationPlan;
  changedPaths: ReadonlySet<string>;
  maxMutants: number;
  /** The longest any one test command may run. */
  timeoutCapMs: number;
  signal: AbortSignal;
  onEvent: (event: ExecutionEvent) => void;
  onUpdate: (execution: MutationExecution) => Promise<void>;
}

function excerpt(output: string): string {
  return redactSecrets(output.trim()).slice(-EXCERPT_CHARS);
}

function mutantTimeout(baseline: BaselineResult, capMs: number): number {
  return Math.min(capMs, Math.max(MIN_MUTANT_TIMEOUT_MS, baseline.durationMs * 3));
}

/** How a mutant's test run ends up scored. */
export function classify(
  run: SandboxedRun,
  argv: string[],
  baselineCount: number | null,
): { outcome: MutantOutcome; testCount: number | null; evidence: string } {
  const counts = parseTestCounts(argv, run.output);
  const testCount = counts?.total ?? null;
  const tail = excerpt(run.output);
  if (run.timedOut)
    return { outcome: "timeout", testCount, evidence: "The tests ran past their time limit." };
  if (run.exitCode === 0) {
    if (testCount !== null && testCount > 0 && testCount === baselineCount) {
      return { outcome: "survived", testCount, evidence: tail };
    }
    return {
      outcome: "error",
      testCount,
      evidence: `The tests passed but ran ${testCount ?? "an unknown number of"} tests, against ${baselineCount} at baseline.\n${tail}`,
    };
  }
  if (testCount !== null && testCount > 0) return { outcome: "killed", testCount, evidence: tail };
  return {
    outcome: "error",
    testCount,
    evidence: `The tests failed without running any (the mutant may not compile).\n${tail}`,
  };
}

export async function executeMutationPlan(
  input: ExecutionInput,
  deps: ExecutorDeps = {},
): Promise<MutationExecution> {
  const runner = deps.runner ?? runSandboxed;
  const tempDir = mkdtempSync(join(tmpdir(), "yarvis-mutation-tmp-"));
  const mutants = input.plan.mutants.slice(0, input.maxMutants);
  const execution: MutationExecution = {
    baselines: [],
    positiveControl: null,
    mutants: [],
    planned: mutants.length,
  };
  const commands = new Map(input.plan.testCommands.map((c) => [c.id, c]));
  const baselines = new Map<string, BaselineResult>();
  const context = { copyRoot: input.copyRoot, changedPaths: input.changedPaths };

  const run = (argv: string[], timeoutMs: number) =>
    runner({ argv, cwd: input.copyRoot, tempDir, timeoutMs, signal: input.signal });

  try {
    await (deps.checkSandbox ?? checkSandbox)(runner, {
      cwd: input.copyRoot,
      tempDir,
      outside: dirname(input.copyRoot),
    });

    input.onEvent({ type: "phase", phase: "baseline" });
    for (const command of input.plan.testCommands) {
      if (input.signal.aborted) return execution;
      const problem = testCommandProblem(command.argv);
      let result: BaselineResult;
      if (problem) {
        result = {
          ...command,
          passed: false,
          exitCode: null,
          durationMs: 0,
          testCount: null,
          problem,
          excerpt: "",
        };
      } else {
        const ran = await run(command.argv, input.timeoutCapMs);
        if (ran.aborted) return execution;
        const counts = parseTestCounts(command.argv, ran.output);
        const passed = !ran.timedOut && ran.exitCode === 0 && (counts?.total ?? 0) > 0;
        result = {
          ...command,
          passed,
          exitCode: ran.exitCode,
          durationMs: ran.durationMs,
          testCount: counts?.total ?? null,
          problem: passed
            ? null
            : ran.timedOut
              ? "it timed out"
              : counts === null
                ? "its output didn't say how many tests ran"
                : counts.total === 0
                  ? "it ran no tests"
                  : `${counts.failed} tests failed before any mutation`,
          excerpt: excerpt(ran.output),
        };
      }
      baselines.set(command.id, result);
      execution.baselines.push(result);
      input.onEvent({ type: "baseline", result });
      await input.onUpdate(execution);
    }

    /** Runs one planned edit end to end; null when cancelled partway. */
    const runEdit = async (
      edit: PlannedEdit & { id: string; rationale: string; testFiles: string[] },
      extra: { likelyEquivalent?: boolean },
    ): Promise<MutantResult | null> => {
      const base = {
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
      };
      const result = (outcome: MutantOutcome, evidence: string): MutantResult => ({
        ...base,
        outcome,
        evidence,
      });
      if (extra.likelyEquivalent) {
        return result("equivalent", "The planner judged this mutant to behave like the original.");
      }
      if (edit.testCommandId === null) {
        return result("uncovered", "No test exercises this code.");
      }
      const command = commands.get(edit.testCommandId);
      const baseline = baselines.get(edit.testCommandId);
      if (!command || !baseline) {
        return result("error", `Rejected: no test command \`${edit.testCommandId}\` in the plan.`);
      }
      if (!baseline.passed) {
        return result(
          "error",
          `Its tests couldn't run cleanly before mutation: ${baseline.problem}.`,
        );
      }
      const prepared = prepareEdit(edit, context);
      if ("refused" in prepared) return result("error", `Rejected: ${prepared.refused}.`);
      const ran = await withEdit(prepared, () =>
        run(command.argv, mutantTimeout(baseline, input.timeoutCapMs)),
      );
      if (ran.aborted) return null;
      const scored = classify(ran, command.argv, baseline.testCount);
      return {
        ...base,
        outcome: scored.outcome,
        durationMs: ran.durationMs,
        testCount: scored.testCount,
        evidence: scored.evidence,
      };
    };

    input.onEvent({ type: "phase", phase: "control" });
    const control = input.plan.positiveControl;
    if (control && !input.signal.aborted) {
      const controlResult = await runEdit(
        { ...control, id: "positive-control", rationale: "", testFiles: [] },
        {},
      );
      if (!controlResult) return execution;
      execution.positiveControl = controlResult;
      input.onEvent({ type: "mutant", result: controlResult, index: 0, total: 1, control: true });
      await input.onUpdate(execution);
    }

    input.onEvent({ type: "phase", phase: "mutants" });
    for (const [index, mutant] of mutants.entries()) {
      if (input.signal.aborted) return execution;
      const result = await runEdit(mutant, { likelyEquivalent: mutant.likelyEquivalent });
      if (!result) return execution;
      execution.mutants.push(result);
      input.onEvent({ type: "mutant", result, index, total: mutants.length, control: false });
      await input.onUpdate(execution);
    }
    return execution;
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}
