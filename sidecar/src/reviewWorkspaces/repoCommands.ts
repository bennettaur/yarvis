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

import { eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns } from "../db/schema.ts";
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
  /** `pending` until the sidecar has run it or decided it can't. */
  status: "pending" | "passed" | "failed" | "not-run";
  exitCode: number | null;
  /** Why it failed or didn't run, in Yarvis's words. */
  reason: string | null;
  /** The tail of its output, redacted. Written by the PR's code: shown, never followed. */
  output: string;
}

export const pendingCommands = (requested: readonly RequestedCommand[]): RepoCommandResult[] =>
  requested.map((c) => ({ ...c, status: "pending", exitCode: null, reason: null, output: "" }));

const notRun = (requested: readonly RequestedCommand[], reason: string): RepoCommandResult[] =>
  requested.map((c) => ({ ...c, status: "not-run", exitCode: null, reason, output: "" }));

/**
 * A baseline run's result as a command's. A repo's command passes on exit
 * code 0, whether or not it printed test counts; one the executor refused
 * never started.
 */
function fromBaseline(
  command: RequestedCommand,
  run: BaselineResult | undefined,
): RepoCommandResult {
  if (!run) return notRun([command], "the run stopped before it")[0] as RepoCommandResult;
  const output = redactSecrets(run.excerpt);
  const result = { ...command, exitCode: run.exitCode, output };
  if (run.exitCode === 0) return { ...result, status: "passed", reason: null };
  if (run.exitCode === null && run.durationMs === 0) {
    return { ...result, status: "not-run", reason: run.problem ?? "it couldn't start" };
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
 * Runs what the repo verification at `runId` asked for, against the commit it
 * read, and writes each command's result onto the run's stored answer. Never
 * throws: a failure is recorded as the commands not running.
 */
export async function runRepoCommands(
  db: Db,
  config: Config,
  run: { id: string; workspaceId: string; prId: string; headSha: string },
  requested: readonly RequestedCommand[],
  deps: RepoCommandDeps = {},
): Promise<RepoCommandResult[]> {
  const results = await execute(db, config, run, requested, deps).catch((e) => {
    console.error(`[verification] repo commands for run ${run.id} failed:`, describeError(e));
    return notRun(requested, "running them failed; see Settings → Diagnostics");
  });
  await recordCommands(db, run.id, results).catch((e) =>
    console.error(`[verification] could not record the repo commands of ${run.id}:`, e),
  );
  return results;
}

async function execute(
  db: Db,
  config: Config,
  run: { id: string; workspaceId: string; prId: string; headSha: string },
  requested: readonly RequestedCommand[],
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
      testCommands: requested.map((c, i) => ({ id: `c${i + 1}`, argv: c.argv, testFiles: [] })),
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
        signal: AbortSignal.timeout(COMMANDS_TIMEOUT_MS),
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
        execution.baselines.find((b) => b.id === `c${i + 1}`),
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

/** A failed command is the server's finding, not the agent's: the exit code says so. */
function commandFinding(result: RepoCommandResult) {
  return {
    title: `\`${result.argv.join(" ")}\` failed`.slice(0, 100),
    detail: (result.reason ?? `It exited with code ${result.exitCode}.`).slice(0, 280),
    severity: "medium" as const,
  };
}

type StoredCheck = { status: string; findings: unknown[]; commands?: RepoCommandResult[] };

/** Writes the results onto the run's stored `repoVerify`, adding a finding per failed command. */
async function recordCommands(db: Db, runId: string, results: RepoCommandResult[]): Promise<void> {
  await db.transaction(async (tx) => {
    const [row] = await tx
      .select({ result: agentRuns.result })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .for("update");
    const stored = row?.result as { repoVerify?: StoredCheck } | null | undefined;
    if (!stored?.repoVerify) return;
    const findings = [
      ...stored.repoVerify.findings,
      ...results.filter((r) => r.status === "failed").map(commandFinding),
    ];
    await tx
      .update(agentRuns)
      .set({
        result: {
          ...stored,
          repoVerify: {
            ...stored.repoVerify,
            status: findings.length > 0 ? "issues" : "pass",
            findings,
            commands: results,
          },
        },
      })
      .where(eq(agentRuns.id, runId));
  });
}
