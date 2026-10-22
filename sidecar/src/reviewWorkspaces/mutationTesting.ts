/**
 * Mutation testing for a PR in a review workspace: does the PR's test suite
 * fail when the logic it changes is wrong? A pass has three parts:
 *
 * 1. A read-only Claude Code run plans the mutants: where, the exact edit, and
 *    which test command covers each, plus a blatant positive control.
 * 2. The sidecar runs the plan itself, in a scratch copy (`mutantCopy.ts`) and
 *    a Seatbelt sandbox (`testSandbox.ts`): baselines, the control, then each
 *    mutant, applied, tested and reverted (`mutationExecutor.ts`). No model
 *    decides what ran or how it scored.
 * 3. When mutants survive, a second read-only run explains why the tests
 *    missed them and what assertion is missing.
 *
 * The summary and verdict are computed from the results (`mutationReport.ts`).
 * Progress streams through `mutationRunRegistry`, and every result is written
 * to the pass's row as it lands.
 *
 * Running the tests runs the PR's code, so a pass only starts on code the user
 * agreed to run: setup consent granted for the current head, and setup
 * succeeded — or there was no setup script and the user confirmed running the
 * tests anyway.
 */

import { and, desc, eq, lt } from "drizzle-orm";
import type { AgentRunEvent } from "../agentRuns/events.ts";
import {
  type AgentRunOutcome,
  agentRunRegistry,
  type ClaudeRunDeps,
  type ClaudeRunOptions,
  startClaudeRun,
} from "../agentRuns/service.ts";
import { type Config, loadInstanceConfig } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type MutationRunRow, mutationRuns, type ReviewWorkspacePr } from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { RunRegistry } from "../lib/runRegistry.ts";
import { redactSecrets } from "../llm/errors.ts";
import { createMutantCopy, type MutantCopyDeps, removeMutantCopy } from "./mutantCopy.ts";
import { type MutationPlan, mutationPlanSchema } from "./mutants.ts";
import { getMutationTestingConfig, type MutationTestingConfig } from "./mutationConfig.ts";
import { type ExecutionEvent, type ExecutorDeps, executeMutationPlan } from "./mutationExecutor.ts";
import {
  attachFindings,
  buildExplanationPrompt,
  buildPlanningPrompt,
  changedFileListing,
  changedRanges,
  explanationInstructions,
  explanationSchema,
  planningInstructions,
} from "./mutationPrompts.ts";
import {
  type MutationExecution,
  type MutationFinding,
  type MutationSummary,
  summarize,
} from "./mutationReport.ts";
import { claimRun } from "./progress.ts";
import {
  getReviewPr,
  type ReviewDeps,
  ReviewWorkspaceError,
  requireActiveWorkspace,
  reviewChangedFiles,
  reviewClonePath,
} from "./service.ts";

// ---------------------------------------------------------------------------
// Gating
// ---------------------------------------------------------------------------

type GatedPr = Pick<
  ReviewWorkspacePr,
  "status" | "headSha" | "worktreeStatus" | "setupConsent" | "setupHeadSha" | "setupStatus"
>;

type MutationGate =
  | { ok: true; headSha: string }
  | { ok: false; reason: string; needsTestConfirmation?: true };

/**
 * Whether mutation testing may run on this PR now, and on which head, or why
 * not. `confirmedRunTests` is the user's explicit yes to running the tests of
 * a PR with no setup script, where consent alone said nothing about what
 * would run.
 */
export function mutationTestingGate(pr: GatedPr, confirmedRunTests: boolean): MutationGate {
  const refuse = (reason: string): MutationGate => ({ ok: false, reason });
  const { headSha } = pr;
  if (pr.status !== "ready" || !headSha) return refuse(`the pull request is ${pr.status}`);
  if (pr.worktreeStatus !== "ready") return refuse(`the checkout is ${pr.worktreeStatus}`);
  if (pr.setupConsent !== "granted") {
    return refuse("running this pull request's code needs your consent first");
  }
  if (pr.setupHeadSha !== headSha) {
    return refuse("consent was given for an earlier commit; review the setup again");
  }
  switch (pr.setupStatus) {
    case "succeeded":
      return { ok: true, headSha };
    case "skipped":
      return confirmedRunTests
        ? { ok: true, headSha }
        : {
            ok: false,
            reason: "there is no setup script; confirm running the tests without one",
            needsTestConfirmation: true,
          };
    case "running":
      return refuse("setup is still running");
    case "failed":
      return refuse("setup failed, so the tests can't be trusted to run");
    default:
      return refuse("setup hasn't run");
  }
}

// ---------------------------------------------------------------------------
// Passes
// ---------------------------------------------------------------------------

export type MutationPhase =
  | "copying"
  | "planning"
  | "baseline"
  | "control"
  | "mutants"
  | "explaining"
  | "done";

export type MutationProgressEvent =
  | { type: "phase"; phase: MutationPhase; agentRunId?: string }
  | { type: "agent"; phase: "planning" | "explaining"; event: AgentRunEvent }
  | Exclude<ExecutionEvent, { type: "phase" }>
  | { type: "error"; message: string }
  | { type: "done"; status: MutationRunRow["status"] };

/** The passes in flight in this process. */
export const mutationRunRegistry = new RunRegistry<MutationProgressEvent>({
  historyCap: 1_000,
  followerQueueCap: 2_000,
});

export interface MutationTestingDeps {
  run?: ClaudeRunDeps;
  copy?: MutantCopyDeps;
  exec?: ExecutorDeps;
  registry?: RunRegistry<MutationProgressEvent>;
  /** Defaults to the settings file. */
  config?: () => Promise<MutationTestingConfig>;
}

/** Copies this process is making or using, which the startup sweep leaves alone. */
export const mutantCopiesInUse = new Set<string>();

/** One start at a time per PR, so two clicks can't both find nothing running. */
const withStartLock = createKeyedLock();

const READ_ONLY_TOOLS = ["Read(./**)", "Grep(./**)", "Glob(./**)"];
const NO_ACTION_TOOLS = ["Bash", "Edit", "Write", "NotebookEdit", "Task"];
const PLANNING_TIMEOUT_MS = 15 * 60 * 1000;
const EXPLANATION_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ERROR_CHARS = 2_000;

async function latestRun(db: Db, prId: string): Promise<MutationRunRow | null> {
  const [row] = await db
    .select()
    .from(mutationRuns)
    .where(eq(mutationRuns.prId, prId))
    .orderBy(desc(mutationRuns.startedAt))
    .limit(1);
  return row ?? null;
}

interface MutationTestingState {
  run: (MutationRunRow & { isCurrentHead: boolean; live: boolean }) | null;
  headSha: string | null;
  /** Why a new pass can't start now, or null when it can. */
  blocked: { reason: string; needsTestConfirmation?: true } | null;
}

/** The PR's latest pass, whether it ran against the current head, and whether one can start. */
export async function getMutationTesting(
  db: Db,
  workspaceId: string,
  prId: string,
  registry: RunRegistry<MutationProgressEvent> = mutationRunRegistry,
): Promise<MutationTestingState> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const run = await latestRun(db, pr.id);
  const gate = mutationTestingGate(pr, false);
  let blocked: MutationTestingState["blocked"] = null;
  if (!gate.ok) {
    const { ok: _ok, ...why } = gate;
    blocked = why;
  }
  return {
    run: run
      ? { ...run, isCurrentHead: run.headSha === pr.headSha, live: registry.isLive(run.id) }
      : null,
    headSha: pr.headSha,
    blocked,
  };
}

/** The id of the PR's pass in flight, if there is one. */
export async function runningMutationRunId(db: Db, workspaceId: string, prId: string) {
  const pr = await getReviewPr(db, workspaceId, prId);
  const run = await latestRun(db, pr.id);
  return run?.status === "running" ? run.id : null;
}

/**
 * Starts a pass, or answers with the one already running for this PR. The
 * request carries the head the user was looking at, and nothing starts unless
 * it is still the PR's head. Answers once the scratch copy exists; planning,
 * running and explaining carry on in the background.
 */
export async function startMutationTesting(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  request: { headSha: string; confirmRunTests: boolean },
  reviewDeps: ReviewDeps,
  deps: MutationTestingDeps = {},
): Promise<{ runId: string; existing: boolean }> {
  return withStartLock(prId, async () => {
    await requireActiveWorkspace(db, workspaceId);
    const pr = await getReviewPr(db, workspaceId, prId);
    const latest = await latestRun(db, pr.id);
    if (latest?.status === "running") return { runId: latest.id, existing: true };

    const gate = mutationTestingGate(pr, request.confirmRunTests);
    if (!gate.ok) throw new ReviewWorkspaceError(gate.reason, 409);
    const { headSha } = gate;
    if (request.headSha !== headSha) {
      throw new ReviewWorkspaceError("the pull request has moved; look at it again", 409);
    }
    // Held until the copy is made, so no refresh or setup can move the
    // worktree while it is read and copied.
    const claim = claimRun(pr.id);
    if (!claim) throw new ReviewWorkspaceError("this pull request is still being updated", 409);

    let row: MutationRunRow;
    let copyPath: string;
    let prompt: string;
    let changedPaths: Set<string>;
    let settings: MutationTestingConfig;
    try {
      claim.emit({ type: "log", text: "Copying the checkout for mutation testing\n" });
      settings = await (deps.config ?? getMutationTestingConfig)();
      const { files, mergeBaseSha } = await reviewChangedFiles(
        db,
        config,
        workspaceId,
        prId,
        reviewDeps,
      );
      const ranges = await changedRanges(
        reviewDeps.git({}).local,
        reviewClonePath(config, pr.ref),
        mergeBaseSha,
        headSha,
      );
      changedPaths = new Set(files.filter((f) => f.status !== "deleted").map((f) => f.path));
      prompt = buildPlanningPrompt({
        headSha,
        maxMutants: settings.maxMutants,
        setupRan: pr.setupStatus === "succeeded",
        files: changedFileListing(files, ranges),
      });
      const [inserted] = await db
        .insert(mutationRuns)
        .values({
          workspaceId,
          prId: pr.id,
          refKey: pr.refKey,
          headSha,
          instance: loadInstanceConfig().name,
          settings,
          // Set here rather than by the database's clock, so the startup
          // sweep compares it with this process's own boot time.
          startedAt: new Date(),
        })
        .returning();
      if (!inserted) throw new Error("could not record the mutation run");
      row = inserted;
      mutantCopiesInUse.add(row.id);
      try {
        copyPath = (await createMutantCopy(config, pr, row.id, headSha, deps.copy)).path;
      } catch (e) {
        mutantCopiesInUse.delete(row.id);
        await db
          .update(mutationRuns)
          .set({ status: "failed", phase: "done", error: errorText(e), finishedAt: new Date() })
          .where(eq(mutationRuns.id, row.id));
        throw e;
      }
    } finally {
      claim.finish();
    }

    const registry = deps.registry ?? mutationRunRegistry;
    const signal = registry.start(row.id);
    void runPass({
      db,
      config,
      row,
      copyPath,
      prompt,
      changedPaths,
      settings,
      signal,
      registry,
      deps,
    });
    return { runId: row.id, existing: false };
  });
}

function errorText(e: unknown): string {
  return redactSecrets(e instanceof Error ? e.message : String(e)).slice(0, MAX_ERROR_CHARS);
}

interface PassContext {
  db: Db;
  config: Config;
  row: MutationRunRow;
  copyPath: string;
  prompt: string;
  changedPaths: Set<string>;
  settings: MutationTestingConfig;
  signal: AbortSignal;
  registry: RunRegistry<MutationProgressEvent>;
  deps: MutationTestingDeps;
}

/**
 * One headless Claude Code run inside a pass: started with the pass's id on
 * it, its events forwarded, and cancelled with the pass.
 */
async function agentStep<T>(
  ctx: PassContext,
  phase: "planning" | "explaining",
  options: ClaudeRunOptions<T>,
): Promise<AgentRunOutcome<T>> {
  const emit = (event: MutationProgressEvent) => ctx.registry.emit(ctx.row.id, event);
  const agents = ctx.deps.run?.registry ?? agentRunRegistry;
  const handle = await startClaudeRun(ctx.db, options, ctx.deps.run);
  await ctx.db
    .update(mutationRuns)
    .set(phase === "planning" ? { planRunId: handle.id } : { explainRunId: handle.id })
    .where(eq(mutationRuns.id, ctx.row.id));
  emit({ type: "phase", phase, agentRunId: handle.id });
  const following = new AbortController();
  void agents.follow(
    handle.id,
    (event) => {
      if (event.type === "status" || event.type === "tool" || event.type === "subagent") {
        emit({ type: "agent", phase, event });
      }
    },
    following.signal,
  );
  const cancel = () => agents.cancel(handle.id);
  ctx.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await handle.done;
  } finally {
    ctx.signal.removeEventListener("abort", cancel);
    following.abort();
  }
}

async function runPass(ctx: PassContext): Promise<void> {
  const { db, row, settings } = ctx;
  const emit = (event: MutationProgressEvent) => ctx.registry.emit(row.id, event);
  const update = (values: Partial<MutationRunRow>) =>
    db.update(mutationRuns).set(values).where(eq(mutationRuns.id, row.id));
  const setPhase = async (phase: MutationPhase) => {
    await update({ phase });
    emit({ type: "phase", phase });
  };

  let cost = 0;
  let status: MutationRunRow["status"] = "failed";
  let error: string | null = null;
  let execution: MutationExecution | null = null;
  let findings: MutationFinding[] | null = null;
  const extraNotes: string[] = [];
  const addCost = (outcome: AgentRunOutcome<unknown>) => {
    cost += outcome.costUsd ?? 0;
  };
  const meta = { mutationRunId: row.id, prId: row.prId, headSha: row.headSha };

  try {
    const planned = await agentStep<MutationPlan>(ctx, "planning", {
      kind: "mutation-plan",
      targetKey: `${row.refKey}@${row.headSha}`,
      cwd: ctx.copyPath,
      prompt: ctx.prompt,
      appendSystemPrompt: planningInstructions,
      outputSchema: mutationPlanSchema,
      allowedTools: READ_ONLY_TOOLS,
      disallowedTools: NO_ACTION_TOOLS,
      ...(settings.planningModel ? { model: settings.planningModel } : {}),
      maxBudgetUsd: settings.planningBudgetUsd,
      maxTurns: 60,
      timeoutMs: PLANNING_TIMEOUT_MS,
      meta,
    });
    addCost(planned);
    if (planned.status === "cancelled" || ctx.signal.aborted) {
      status = "cancelled";
      return;
    }
    if (planned.status !== "succeeded" || !planned.output) {
      throw new Error(`planning failed: ${planned.error ?? "no plan"}`);
    }
    const plan = planned.output;
    await update({ plan, costUsd: cost });

    execution = await executeMutationPlan(
      {
        copyRoot: ctx.copyPath,
        plan,
        changedPaths: ctx.changedPaths,
        maxMutants: settings.maxMutants,
        timeoutCapMs: settings.testTimeoutCapSeconds * 1000,
        signal: ctx.signal,
        onEvent: (event) => {
          if (event.type === "phase") void setPhase(event.phase);
          else emit(event);
        },
        onUpdate: async (latest) => {
          execution = latest;
          await update({ execution: latest, summary: summarize(latest, { finished: false }) });
        },
      },
      ctx.deps.exec,
    );
    if (plan.notes.trim()) extraNotes.push(`Planner: ${plan.notes.trim()}`);
    if (ctx.signal.aborted) {
      status = "cancelled";
      return;
    }

    const survivors = execution.mutants.filter((m) => m.outcome === "survived");
    if (survivors.length > 0) {
      const commands = new Map(plan.testCommands.map((c) => [c.id, c.argv]));
      const explained = await agentStep(ctx, "explaining", {
        kind: "mutation-explain",
        targetKey: `${row.refKey}@${row.headSha}`,
        cwd: ctx.copyPath,
        prompt: buildExplanationPrompt(survivors, commands),
        appendSystemPrompt: explanationInstructions,
        outputSchema: explanationSchema,
        allowedTools: READ_ONLY_TOOLS,
        disallowedTools: NO_ACTION_TOOLS,
        ...(settings.explanationModel ? { model: settings.explanationModel } : {}),
        maxBudgetUsd: settings.explanationBudgetUsd,
        maxTurns: 30,
        timeoutMs: EXPLANATION_TIMEOUT_MS,
        meta,
      });
      addCost(explained);
      if (explained.status === "cancelled" || ctx.signal.aborted) {
        status = "cancelled";
        return;
      }
      if (explained.status === "succeeded" && explained.output) {
        findings = attachFindings(explained.output, survivors);
      } else {
        extraNotes.push(`The survivors couldn't be explained: ${explained.error ?? "no answer"}`);
      }
    } else {
      findings = [];
    }
    status = "succeeded";
  } catch (e) {
    if (ctx.signal.aborted) status = "cancelled";
    else {
      error = errorText(e);
      emit({ type: "error", message: error });
    }
  } finally {
    let summary: MutationSummary | null = null;
    if (execution) {
      summary = summarize(execution, { finished: status === "succeeded" });
      summary.notes.push(...extraNotes);
    }
    try {
      await update({
        status,
        phase: "done",
        execution,
        summary,
        findings,
        error,
        costUsd: cost,
        finishedAt: new Date(),
      });
    } catch (e) {
      console.error(`[mutation-testing] could not record the end of run ${row.id}:`, e);
    }
    emit({ type: "done", status });
    ctx.registry.finish(row.id);
    try {
      await removeMutantCopy(ctx.config, row.workspaceId, ctx.copyPath);
    } catch (e) {
      console.error(`[mutation-testing] could not remove ${ctx.copyPath}:`, e);
    }
    mutantCopiesInUse.delete(row.id);
  }
}

/**
 * Fails the passes this instance left `running` when it last stopped. Their
 * Claude Code runs are swept as agent runs; their copies by the copy sweep,
 * which runs after this.
 */
export async function failInterruptedMutationRuns(
  db: Db,
  instance: string,
  startedBefore: Date,
): Promise<number> {
  const rows = await db
    .update(mutationRuns)
    .set({
      status: "failed",
      phase: "done",
      error: "interrupted: Yarvis stopped while this run was in progress",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(mutationRuns.status, "running"),
        eq(mutationRuns.instance, instance),
        lt(mutationRuns.startedAt, startedBefore),
      ),
    )
    .returning({ id: mutationRuns.id });
  return rows.length;
}
