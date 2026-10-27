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
import { claimDueCheckBacks, recordCheckBackError } from "./service.ts";

/**
 * Runs the check-backs that have come due, each as a turn in the chat that
 * scheduled it.
 *
 * The turn has nobody at the other end to approve anything, so it runs the way
 * any surface that can't prompt does: no MCP tools, and the destructive and
 * outward-facing built-ins dropped. What it can do is look things up, schedule
 * the next check, and ask for the user's attention.
 */

export const CHECK_BACKS_JOB_NAME = "check-backs";

/** Check-backs started per tick. The rest wait a minute for the next one. */
const MAX_PER_RUN = 5;

/** How long one check-back turn gets before it is abandoned. */
export const CHECK_BACK_TURN_TIMEOUT_MS = 5 * 60_000;

export interface CheckBackTurnOutcome {
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
 * The text the check-back turn is sent as. It is stored in the chat, so the
 * header is what tells the user — and the model on later turns — that this was
 * the assistant's own note and not something the user typed.
 */
export function checkBackMessage(checkBack: ChatCheckBack): string {
  return `[Check-back ${checkBack.attempt}, scheduled ${checkBack.createdAt.toISOString()}]\n${checkBack.prompt}`;
}

export const runCheckBackTurn: CheckBackTurnRunner = async ({ config, db, checkBack, signal }) => {
  const chosen =
    checkBack.provider && checkBack.model
      ? { provider: checkBack.provider, model: checkBack.model }
      : await defaultProviderModel(config);
  if (!chosen) return { error: "no chat model is configured" };
  let model: Awaited<ReturnType<typeof resolveModel>>;
  try {
    model = await resolveModel(config, chosen.provider, chosen.model);
  } catch (e) {
    return { error: `model unavailable (${chosen.provider} / ${chosen.model}): ${String(e)}` };
  }

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
    budget: await getChatBudget(config, chosen.provider, chosen.model),
  })) {
    if (event.type === "attention") outcome.attentionReason = event.reason ?? "Check-back finished";
    else if (event.type === "error") outcome.error = event.message;
  }
  return outcome;
};

async function notify(db: Db, checkBack: ChatCheckBack, kind: "info" | "error", title: string) {
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

async function runOne(
  config: Config,
  db: Db,
  checkBack: ChatCheckBack,
  runTurn: CheckBackTurnRunner,
): Promise<void> {
  let outcome: CheckBackTurnOutcome;
  try {
    outcome = await runTurn({
      config,
      db,
      checkBack,
      signal: AbortSignal.timeout(CHECK_BACK_TURN_TIMEOUT_MS),
    });
  } catch (e) {
    outcome = { error: e instanceof Error ? e.message : String(e) };
  }
  if (outcome.error) {
    const error = redactSecrets(outcome.error);
    console.error(`[check-backs] ${checkBack.id} failed: ${error}`);
    await recordCheckBackError(db, checkBack.id, error);
    // The user is waiting to hear back; a check that broke must not look like
    // one that is still waiting.
    await notify(db, checkBack, "error", "A check-back Yarvis scheduled failed");
    return;
  }
  if (outcome.attentionReason) {
    await notify(db, checkBack, "info", outcome.attentionReason);
  }
}

export function checkBacksJob(runTurn: CheckBackTurnRunner = runCheckBackTurn): JobDefinition {
  return {
    name: CHECK_BACKS_JOB_NAME,
    description: "Runs the follow-up checks the assistant scheduled for itself in a chat.",
    // Under the scheduler's one-minute tick, so every tick counts as due rather
    // than clock jitter making it skip alternate ones.
    schedule: { kind: "interval", everyMs: 30_000 },
    // The turns run side by side, so one batch takes about as long as its slowest turn.
    leaseMs: CHECK_BACK_TURN_TIMEOUT_MS + 60_000,
    run: async (ctx) => {
      const due = await claimDueCheckBacks(ctx.db, ctx.now, MAX_PER_RUN);
      if (due.length === 0) return { skipped: true };
      await Promise.all(due.map((checkBack) => runOne(ctx.config, ctx.db, checkBack, runTurn)));
      return { detail: `ran ${due.length} check-back(s)` };
    },
  };
}
