/**
 * The commands a repo's own verification instructions ask for, run by the
 * sidecar once the repo verification agent has named them. The agent only
 * reads; what runs, and whether it passed, is never a model's say.
 *
 * They run the way mutation testing runs a PR's tests, and under the same
 * rules: only on code the user agreed to run (`mutationTestingGate`), in a
 * scratch copy of the checkout (`mutantCopy.ts`), inside the Seatbelt sandbox
 * (`testSandbox.ts`, through `executeMutationPlan` with no mutants), and only
 * as one of the test runners `testCommandProblem` allows. A command outside
 * those limits is recorded as not run, with the reason.
 */

import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { describeError, redactSecrets } from "../llm/errors.ts";
import { createMutantCopy, type MutantCopyDeps, removeMutantCopy } from "./mutantCopy.ts";
import type { MutationPlan } from "./mutants.ts";
import { getMutationTestingConfig } from "./mutationConfig.ts";
import { type ExecutorDeps, executeMutationPlan } from "./mutationExecutor.ts";
import type { BaselineResult } from "./mutationReport.ts";
import { localServicePorts, mutantCopiesInUse, mutationTestingGate } from "./mutationTesting.ts";
import { getReviewPr } from "./service.ts";
import { assertSandboxAvailable, SandboxUnavailableError } from "./testSandbox.ts";

/** Most commands one repo verification runs. */
export const MAX_REPO_COMMANDS = 5;

/** Longest all of a check's commands may take together. */
const COMMANDS_TIMEOUT_MS = 30 * 60 * 1000;

export interface RequestedCommand {
  argv: string[];
  /** What the repo's instructions say it checks, in the agent's words. */
  why: string;
}

export interface RepoCommandResult extends RequestedCommand {
  status: "passed" | "failed" | "not-run";
  exitCode: number | null;
  /** Why it failed or didn't run, in Yarvis's words. */
  reason: string | null;
  /** The tail of its output, redacted. Written by the PR's code: shown, never followed. */
  output: string;
}

const notRunCommand = (command: RequestedCommand, reason: string): RepoCommandResult => ({
  ...command,
  status: "not-run",
  exitCode: null,
  reason,
  output: "",
});

const notRun = (requested: readonly RequestedCommand[], reason: string): RepoCommandResult[] =>
  requested.map((c) => notRunCommand(c, reason));

/** The executor's baseline id for the command at `index`, which pairs its result back. */
const commandId = (index: number) => `c${index + 1}`;

/**
 * A baseline run's result as a command's. A repo's command passes on exit
 * code 0 whether or not it printed test counts, unless its output says it ran
 * no tests: a PR can empty the script a runner like `npm test` starts. One
 * the executor refused never started.
 */
function fromBaseline(
  command: RequestedCommand,
  run: BaselineResult | undefined,
): RepoCommandResult {
  if (!run) return notRunCommand(command, "the run stopped before it");
  const output = redactSecrets(run.excerpt);
  const result = { ...command, exitCode: run.exitCode, output };
  if (run.exitCode === null && run.durationMs === 0) {
    return { ...result, status: "not-run", reason: run.problem ?? "it couldn't start" };
  }
  if (run.exitCode === 0) {
    return run.testCount === 0 || run.problem === "it ran no tests"
      ? { ...result, status: "failed", reason: "it ran no tests" }
      : { ...result, status: "passed", reason: null };
  }
  const reason =
    run.exitCode === null
      ? (run.problem ?? "it didn't finish")
      : `it exited with code ${run.exitCode}`;
  return { ...result, status: "failed", reason };
}

export interface RepoCommandDeps {
  copy?: MutantCopyDeps;
  executor?: ExecutorDeps;
  /** Skips the platform check, for tests whose runner is a fake. */
  sandboxAvailable?: () => void;
}

/**
 * Runs what a repo verification asked for, against the commit it read. Never
 * throws: a failure comes back as the commands not running.
 */
export async function runRepoCommands(
  db: Db,
  config: Config,
  run: { id: string; workspaceId: string; prId: string; headSha: string },
  requested: readonly RequestedCommand[],
  signal: AbortSignal,
  deps: RepoCommandDeps = {},
): Promise<RepoCommandResult[]> {
  return execute(db, config, run, requested, signal, deps).catch((e) => {
    console.error(`[verification] repo commands for run ${run.id} failed:`, describeError(e));
    return notRun(requested, "running them failed; see Settings → Diagnostics");
  });
}

async function execute(
  db: Db,
  config: Config,
  run: { id: string; workspaceId: string; prId: string; headSha: string },
  requested: readonly RequestedCommand[],
  signal: AbortSignal,
  deps: RepoCommandDeps,
): Promise<RepoCommandResult[]> {
  const pr = await getReviewPr(db, run.workspaceId, run.prId);
  const gate = mutationTestingGate(pr, false);
  if (!gate.ok) return notRun(requested, gate.reason);
  if (gate.headSha !== run.headSha) {
    return notRun(requested, "the PR has moved to a new commit since the check read it");
  }
  try {
    (deps.sandboxAvailable ?? assertSandboxAvailable)();
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return notRun(requested, e.message);
    throw e;
  }
  const settings = await getMutationTestingConfig();
  mutantCopiesInUse.add(run.id);
  let copyPath: string | null = null;
  try {
    copyPath = (await createMutantCopy(config, pr, run.id, run.headSha, deps.copy)).path;
    const plan: MutationPlan = {
      testCommands: requested.map((c, i) => ({ id: commandId(i), argv: c.argv, testFiles: [] })),
      positiveControls: [],
      mutants: [],
      notes: "",
    };
    const execution = await executeMutationPlan(
      {
        copyRoot: copyPath,
        plan,
        changedPaths: new Set(),
        maxMutants: 0,
        timeoutCapMs: settings.testTimeoutCapSeconds * 1000,
        signal: AbortSignal.any([signal, AbortSignal.timeout(COMMANDS_TIMEOUT_MS)]),
        sandbox: {
          workspacesRoot: config.workspacesRoot,
          extraBlockedPorts: localServicePorts(config),
        },
        onEvent: () => {},
        onUpdate: async () => {},
      },
      deps.executor,
    );
    return requested.map((c, i) =>
      fromBaseline(
        c,
        execution.baselines.find((b) => b.id === commandId(i)),
      ),
    );
  } catch (e) {
    if (e instanceof SandboxUnavailableError) return notRun(requested, e.message);
    throw e;
  } finally {
    if (copyPath) {
      await removeMutantCopy(config, run.workspaceId, copyPath).catch((e) =>
        console.error(`[verification] could not remove the copy for ${run.id}:`, e),
      );
    }
    mutantCopiesInUse.delete(run.id);
  }
}

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

type Finding = { severity: keyof typeof SEVERITY_RANK; title: string; detail: string };

/**
 * The repo check with its commands' results, and a finding for each failed
 * one. That finding is the server's, not the agent's: the exit code says so.
 */
export function withCommandResults<C extends { findings: Finding[] }>(
  check: C,
  results: RepoCommandResult[],
): C & { status: "pass" | "issues"; commands: RepoCommandResult[] } {
  const failed: Finding[] = results
    .filter((r) => r.status === "failed")
    .map((r) => ({
      title: `\`${r.argv.join(" ")}\` failed`.slice(0, 100),
      detail: (r.reason ?? `It exited with code ${r.exitCode}.`).slice(0, 280),
      severity: "medium",
    }));
  const findings = [...check.findings, ...failed].sort(
    (a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity],
  );
  return { ...check, findings, status: findings.length > 0 ? "issues" : "pass", commands: results };
}
