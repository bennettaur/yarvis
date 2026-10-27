import type { LanguageModel } from "ai";
import { publish } from "../attention/hub.ts";
import { createAttention } from "../attention/service.ts";
import { runAgentTurn } from "../chat/agent.ts";
import { getChatBudget } from "../chat/config.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { ChatCheckBack } from "../db/schema.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { redactSecrets } from "../llm/errors.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";
import { claimDueCheckBacks, MAX_CHECK_BACK_ATTEMPTS, recordCheckBackError } from "./service.ts";

/**
 * Runs the check-backs that have come due, each as a turn in the chat that
 * scheduled it.
 *
 * The turn has nobody at the other end to approve anything, so `runAgentTurn`
 * gives it only the read-only tools in `CHECK_BACK_TOOLS` and no MCP tools. What
 * it can do is look things up, schedule the next check, and ask for the user's
 * attention.
 */

/** Check-backs started per tick. The rest wait a minute for the next one. */
const MAX_PER_RUN = 5;

/** How long one check-back turn gets before it is abandoned. */
const CHECK_BACK_TURN_TIMEOUT_MS = 5 * 60_000;

/**
 * Steps a check-back turn gets, well under a typed turn's budget: it should read
 * one or two things and either report or reschedule, and it repeats up to
 * `MAX_CHECK_BACK_ATTEMPTS` times.
 */
const CHECK_BACK_MAX_STEPS = 10;

interface CheckBackTurnOutcome {
  /** Set when the turn called `request_attention`. */
  attentionReason?: string;
  /** Set when the turn could not run or the model failed. */
  error?: string;
}

export type CheckBackTurnRunner = (input: {
  config: Config;
  db: Db;
  checkBack: ChatCheckBack;
  signal: AbortSignal;
}) => Promise<CheckBackTurnOutcome>;

/**
 * The text the check-back turn is stored as. The header is what tells the user
 * that this was the assistant's own note and not something they typed.
 */
export function checkBackMessage(checkBack: ChatCheckBack): string {
  return `[Check-back ${checkBack.attempt}, scheduled ${checkBack.createdAt.toISOString()}]\n${checkBack.prompt}`;
}

const runCheckBackTurn: CheckBackTurnRunner = async ({ config, db, checkBack, signal }) => {
  const chosen =
    checkBack.provider && checkBack.model
      ? { provider: checkBack.provider, model: checkBack.model }
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
  const outcome: CheckBackTurnOutcome = {};
  for await (const event of runAgentTurn({
    config,
    db,
    model,
    modelRef: chosen,
    sessionId: checkBack.sessionId,
    message: checkBackMessage(checkBack),
    userMetadata: {
      source: "check-back",
      checkBack: { id: checkBack.id, attempt: checkBack.attempt },
    },
    signal,
    budget: { ...budget, maxSteps: Math.min(budget.maxSteps, CHECK_BACK_MAX_STEPS) },
  })) {
    if (event.type === "attention") outcome.attentionReason = event.reason ?? "Check-back finished";
    else if (event.type === "error") outcome.error = event.message;
  }
  // An abort ends the turn the way a user's Stop does, and the error it reports
  // says so; this one wasn't the user's doing.
  if (signal.aborted) outcome.error = "the check-back timed out";
  return outcome;
};

/**
 * Settles after the timeout even if the turn doesn't. The abort signal only
 * stops work that listens for it, and a tool stuck on a slow call would
 * otherwise hold the whole scheduler tick.
 */
async function withHardTimeout(
  run: (signal: AbortSignal) => Promise<CheckBackTurnOutcome>,
): Promise<CheckBackTurnOutcome> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<CheckBackTurnOutcome>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      resolve({ error: "the check-back timed out" });
    }, CHECK_BACK_TURN_TIMEOUT_MS);
  });
  try {
    return await Promise.race([run(controller.signal), timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

async function raiseAttention(
  db: Db,
  checkBack: ChatCheckBack,
  kind: "info" | "error",
  title: string,
) {
  const item = await createAttention(db, {
    source: "chat-agent",
    // One live notification per chat: a later check-back replaces the earlier
    // one's text rather than stacking beside it.
    sessionKey: `chat:${checkBack.sessionId}`,
    kind,
    title,
    navTarget: { type: "chat" },
    payload: { checkBackId: checkBack.id },
  });
  publish(item);
}

async function runDueCheckBack(
  config: Config,
  db: Db,
  checkBack: ChatCheckBack,
  runTurn: CheckBackTurnRunner,
): Promise<void> {
  let outcome: CheckBackTurnOutcome;
  try {
    outcome = await withHardTimeout((signal) => runTurn({ config, db, checkBack, signal }));
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }
  if (outcome.error) {
    const error = redactSecrets(outcome.error);
    console.error(`[check-backs] ${checkBack.id} failed: ${error}`);
    await recordCheckBackError(db, checkBack.id, error);
    // The user is waiting to hear back; a check that broke must not look like
    // one that is still waiting.
    await raiseAttention(db, checkBack, "error", "A check-back Yarvis scheduled failed");
    return;
  }
  if (outcome.attentionReason) {
    await raiseAttention(db, checkBack, "info", outcome.attentionReason);
  } else if (checkBack.attempt >= MAX_CHECK_BACK_ATTEMPTS) {
    // The chain can't continue, and the user asked to hear how it ended.
    await raiseAttention(
      db,
      checkBack,
      "info",
      `Yarvis stopped watching after ${MAX_CHECK_BACK_ATTEMPTS} checks`,
    );
  }
}

export function checkBacksJob(runTurn: CheckBackTurnRunner = runCheckBackTurn): JobDefinition {
  return {
    name: "check-backs",
    description: "Runs the follow-up checks the assistant scheduled for itself in a chat.",
    // Due on every scheduler tick.
    schedule: { kind: "interval", everyMs: 0 },
    // Chats run side by side, so a batch takes about as long as its slowest chat.
    leaseMs: MAX_PER_RUN * CHECK_BACK_TURN_TIMEOUT_MS + 60_000,
    run: async (ctx) => {
      const due = await claimDueCheckBacks(ctx.db, ctx.now, MAX_PER_RUN);
      if (due.length === 0) return { skipped: true };
      // One chat's check-backs run in order: two turns at once would each replay
      // a history missing the other's messages.
      const bySession = Map.groupBy(due, (checkBack) => checkBack.sessionId);
      const results = await Promise.allSettled(
        [...bySession.values()].map(async (group) => {
          for (const checkBack of group) {
            await runDueCheckBack(ctx.config, ctx.db, checkBack, runTurn);
          }
        }),
      );
      const failed = results.filter((r) => r.status === "rejected");
      for (const r of failed) {
        console.error(
          "[check-backs] could not record an outcome:",
          redactSecrets(String(r.reason)),
        );
      }
      return {
        detail: `ran ${due.length} check-back(s)${failed.length ? `, ${failed.length} chat(s) failed to record` : ""}`,
      };
    },
  };
}
