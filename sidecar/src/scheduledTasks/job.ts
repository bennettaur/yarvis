import type { LanguageModel } from "ai";
import { publish } from "../attention/hub.ts";
import { createAttention } from "../attention/service.ts";
import { runAgentTurn } from "../chat/agent.ts";
import { getChatBudget } from "../chat/config.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AttentionNavTarget, ChatScheduledTask } from "../db/schema.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { redactSecrets } from "../llm/errors.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";
import {
  claimDueScheduledTasks,
  hasFollowUp,
  MAX_SCHEDULED_TASK_ATTEMPTS,
  recordScheduledTaskError,
} from "./service.ts";

/**
 * Runs the scheduled tasks that have come due, each as a turn in the chat that
 * scheduled it, and rings the attention bell with what it found.
 *
 * The turn has nobody at the other end to approve anything, so `runAgentTurn`
 * gives it only the read-only tools in `SCHEDULED_TASK_TOOLS` and no MCP tools.
 */

/** Tasks started per tick. The rest wait a minute for the next one. */
const MAX_PER_RUN = 5;

/** How long one task's turn gets before it is abandoned. */
const SCHEDULED_TASK_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Steps a task's turn gets, well under a typed turn's budget: it should read a
 * few things and report, and a chain of them repeats up to
 * `MAX_SCHEDULED_TASK_ATTEMPTS` times.
 */
const SCHEDULED_TASK_MAX_STEPS = 10;

/** How much of the reply the notification carries; the rest is in the chat. */
const MAX_BODY_CHARS = 300;

interface ScheduledTaskTurnOutcome {
  /** The reply the turn ended with. */
  reply?: string;
  /** Set when the turn called `request_attention`. */
  attentionReason?: string;
  /** Set when the turn could not run or the model failed. */
  error?: string;
}

export type ScheduledTaskTurnRunner = (input: {
  config: Config;
  db: Db;
  scheduledTask: ChatScheduledTask;
  signal: AbortSignal;
}) => Promise<ScheduledTaskTurnOutcome>;

/**
 * The text the task's turn is stored as. The header is what tells the user that
 * this was the assistant's own note and not something they typed.
 */
export function scheduledTaskMessage(scheduledTask: ChatScheduledTask): string {
  const run = scheduledTask.attempt > 1 ? `, run ${scheduledTask.attempt}` : "";
  return `[Scheduled task: ${scheduledTask.title}${run}, scheduled ${scheduledTask.createdAt.toISOString()}]\n${scheduledTask.prompt}`;
}

const runScheduledTaskTurn: ScheduledTaskTurnRunner = async ({
  config,
  db,
  scheduledTask,
  signal,
}) => {
  const chosen =
    scheduledTask.provider && scheduledTask.model
      ? { provider: scheduledTask.provider, model: scheduledTask.model }
      : await defaultProviderModel(config);
  if (!chosen) return { error: "no chat model is configured" };
  let model: LanguageModel;
  try {
    model = await resolveModel(config, chosen.provider, chosen.model);
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { error: `model unavailable (${chosen.provider} / ${chosen.model}): ${reason}` };
  }

  const budget = await getChatBudget(config, chosen.provider, chosen.model);
  const outcome: ScheduledTaskTurnOutcome = {};
  for await (const event of runAgentTurn({
    config,
    db,
    model,
    modelRef: chosen,
    sessionId: scheduledTask.sessionId,
    message: scheduledTaskMessage(scheduledTask),
    userMetadata: {
      source: "scheduled-task",
      scheduledTask: {
        id: scheduledTask.id,
        attempt: scheduledTask.attempt,
        origin: scheduledTask.origin,
      },
    },
    signal,
    budget: { ...budget, maxSteps: Math.min(budget.maxSteps, SCHEDULED_TASK_MAX_STEPS) },
  })) {
    if (event.type === "done") outcome.reply = event.text;
    else if (event.type === "attention") outcome.attentionReason = event.reason;
    else if (event.type === "error") outcome.error = event.message;
  }
  // An abort ends the turn the way a user's Stop does, and the error it reports
  // says so; this one wasn't the user's doing.
  if (signal.aborted) outcome.error = "the scheduled task timed out";
  return outcome;
};

/**
 * Settles after the timeout even if the turn doesn't. The abort signal only
 * stops work that listens for it, and a tool stuck on a slow call would
 * otherwise hold the whole scheduler tick.
 */
async function withHardTimeout(
  run: (signal: AbortSignal) => Promise<ScheduledTaskTurnOutcome>,
): Promise<ScheduledTaskTurnOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<ScheduledTaskTurnOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ error: "the scheduled task timed out" });
    }, SCHEDULED_TASK_TURN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Where the bell item takes the user. A heads-down pass's chat is hidden, so its
 * tasks open the Heads down page; any other opens the chat the task ran in.
 */
function navTargetFor(scheduledTask: ChatScheduledTask): AttentionNavTarget {
  return scheduledTask.origin === "heads-down"
    ? { type: "heads-down" }
    : { type: "chat", sessionId: scheduledTask.sessionId };
}

function excerpt(text: string | undefined): string | null {
  const trimmed = text?.trim();
  if (!trimmed) return null;
  return trimmed.length > MAX_BODY_CHARS ? `${trimmed.slice(0, MAX_BODY_CHARS)}…` : trimmed;
}

async function raiseAttention(
  db: Db,
  scheduledTask: ChatScheduledTask,
  kind: "info" | "error",
  title: string,
  body: string | null,
) {
  const item = await createAttention(db, {
    source: "chat-agent",
    sessionKey: `scheduled-task:${scheduledTask.id}`,
    kind,
    title,
    body,
    navTarget: navTargetFor(scheduledTask),
    payload: { scheduledTaskId: scheduledTask.id },
  });
  publish(item);
}

async function runDueScheduledTask(
  config: Config,
  db: Db,
  scheduledTask: ChatScheduledTask,
  runTurn: ScheduledTaskTurnRunner,
): Promise<void> {
  let outcome: ScheduledTaskTurnOutcome;
  try {
    outcome = await withHardTimeout((signal) => runTurn({ config, db, scheduledTask, signal }));
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }
  if (outcome.error) {
    const error = redactSecrets(outcome.error);
    console.error(`[scheduled-tasks] ${scheduledTask.id} failed: ${error}`);
    await recordScheduledTaskError(db, scheduledTask.id, error);
    // The user is expecting to hear back; a task that broke must not look like
    // one that is still waiting.
    await raiseAttention(
      db,
      scheduledTask,
      "error",
      `Scheduled task failed: ${scheduledTask.title}`,
      error,
    );
    return;
  }
  // A task that only scheduled its next run, with nothing to say, has nothing
  // for the user yet: a CI watch would otherwise ring the bell every ten minutes.
  if (!outcome.attentionReason && (await hasFollowUp(db, scheduledTask))) return;
  const title =
    outcome.attentionReason ??
    (scheduledTask.attempt >= MAX_SCHEDULED_TASK_ATTEMPTS
      ? `Stopped after ${MAX_SCHEDULED_TASK_ATTEMPTS} runs: ${scheduledTask.title}`
      : `Yarvis has an update: ${scheduledTask.title}`);
  await raiseAttention(db, scheduledTask, "info", title, excerpt(outcome.reply));
}

export function scheduledTasksJob(
  runTurn: ScheduledTaskTurnRunner = runScheduledTaskTurn,
): JobDefinition {
  return {
    name: "scheduled-tasks",
    description: "Runs the tasks the assistant scheduled for itself in a chat.",
    // Due on every scheduler tick.
    schedule: { kind: "interval", everyMs: 0 },
    // Chats run side by side, so a batch takes about as long as its slowest chat.
    leaseMs: MAX_PER_RUN * SCHEDULED_TASK_TURN_TIMEOUT_MS + 60_000,
    run: async (ctx) => {
      const due = await claimDueScheduledTasks(ctx.db, ctx.now, MAX_PER_RUN);
      if (due.length === 0) return { skipped: true };
      // One chat's tasks run in order: two turns at once would each replay a
      // history missing the other's messages.
      const bySession = Map.groupBy(due, (scheduledTask) => scheduledTask.sessionId);
      const results = await Promise.allSettled(
        [...bySession.values()].map(async (group) => {
          for (const scheduledTask of group) {
            await runDueScheduledTask(ctx.config, ctx.db, scheduledTask, runTurn);
          }
        }),
      );
      const failed = results.filter((r) => r.status === "rejected");
      for (const r of failed) {
        console.error(
          "[scheduled-tasks] could not record an outcome:",
          redactSecrets(String(r.reason)),
        );
      }
      return {
        detail: `ran ${due.length} scheduled task(s)${failed.length ? `, ${failed.length} chat(s) failed to record` : ""}`,
      };
    },
  };
}
