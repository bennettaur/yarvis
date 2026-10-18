import type { LanguageModel } from "ai";
import { runAgentTurn } from "../chat/agent.ts";
import { builtinToolMetadataByFamily } from "../chat/builtinTools.ts";
import { getChatBudget } from "../chat/config.ts";
import { createSession } from "../chat/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { HeadsDownRun } from "../db/schema.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";
import { mountTools, unmountAll } from "../mcp/mountedTools.ts";
import { listStreams } from "../workStreams/service.ts";
import {
  chooseSleep,
  getHeadsDownConfig,
  type HeadsDownConfig,
  isWithinWorkingHours,
} from "./config.ts";
import { publish } from "./hub.ts";
import { buildPassTools, newPassOutcome } from "./passTools.ts";
import { PASS_CONFIRMED_TOOLS, passApprovalHooks } from "./policy.ts";
import { buildPassPrompt, PASS_INSTRUCTIONS } from "./prompt.ts";
import {
  answeredSince,
  finishPass,
  lastFinishedPass,
  lastUserActivityAt,
  listQuestions,
  markMessagesSeen,
  startPass,
  unseenMessages,
} from "./service.ts";

/**
 * The built-in families a pass works with, mounted for it so it doesn't spend
 * steps finding them. Anything else (an MCP Slack server, say) it can still
 * search for and mount itself.
 */
const PASS_FAMILIES = ["workStreams", "workspaces", "jira", "prReview", "browser"];

/** How long a pass may run before it is stopped. */
export const PASS_TIMEOUT_MS = 20 * 60_000;

export interface PassResult {
  passId: string;
  sleepMinutes: number;
  sleepReason: string;
}

async function passModel(config: Config, hd: HeadsDownConfig) {
  const chosen =
    hd.provider && hd.model
      ? { provider: hd.provider, model: hd.model }
      : await defaultProviderModel(config);
  if (!chosen) throw new Error("no LLM provider is configured");
  return {
    model: await resolveModel(config, chosen.provider, chosen.model),
    budget: await getChatBudget(config, chosen.provider, chosen.model),
  };
}

function passToolIds(): string[] {
  const families = builtinToolMetadataByFamily();
  return PASS_FAMILIES.flatMap((family) =>
    Object.keys(families[family] ?? {}).map((name) => `builtin:${name}`),
  );
}

/**
 * Runs one pass of the heads-down loop and decides how long to sleep after it.
 * `model` replaces the configured one, for tests.
 */
export async function runPass(
  config: Config,
  db: Db,
  run: HeadsDownRun,
  options: { model?: LanguageModel } = {},
): Promise<PassResult> {
  const hd = await getHeadsDownConfig();
  const now = new Date();
  const [messages, last, openQuestions, lastActivity] = await Promise.all([
    unseenMessages(db),
    lastFinishedPass(db, run.id),
    listQuestions(db, ["open"]),
    lastUserActivityAt(db, run),
  ]);
  const answers = await answeredSince(db, last?.startedAt ?? run.startedAt);
  const withinWorkingHours = isWithinWorkingHours(now, hd.workingHours);
  const minutesSinceUserReplied = Math.round((now.getTime() - lastActivity.getTime()) / 60_000);

  const session = await createSession(db, `Heads down · ${now.toISOString()}`, { hidden: true });
  const pass = await startPass(db, run.id, session.id);
  publish({ type: "pass-started", passId: pass.id });

  const outcome = newPassOutcome();
  const changed = () => publish({ type: "changed" });
  let error: string | null = null;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), PASS_TIMEOUT_MS);
  try {
    const { model, budget } = options.model
      ? { model: options.model, budget: undefined }
      : await passModel(config, hd);
    mountTools(session.id, passToolIds());
    for await (const event of runAgentTurn({
      config,
      db,
      model,
      sessionId: session.id,
      message: buildPassPrompt({
        now,
        run,
        withinWorkingHours,
        minutesSinceUserReplied,
        messages,
        answers,
        openQuestions,
        lastNotes: last?.notes ?? null,
      }),
      userMetadata: { source: "heads-down" },
      signal: abort.signal,
      approval: passApprovalHooks(db, changed),
      confirmBuiltins: PASS_CONFIRMED_TOOLS,
      instructions: PASS_INSTRUCTIONS,
      extraTools: buildPassTools(db, outcome, changed),
      budget,
    })) {
      publish({ type: "pass-event", passId: pass.id, event });
      if (event.type === "error") error = event.message;
    }
    // Seen once a pass has had them in its prompt, even one that failed
    // part-way: re-sending the same instruction every pass would loop on it.
    await markMessagesSeen(
      db,
      messages.map((m) => m.id),
    );
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("[heads-down] pass failed:", error);
  } finally {
    clearTimeout(timer);
    unmountAll(session.id);
  }

  // Once finish_pass has run, the pass is done: a turn that then ends with no
  // closing text, or fails on a later step, hasn't lost anything.
  if (outcome.finished) error = null;
  const awake = await listStreams(db, { awakeAt: new Date() });
  const sleep = chooseSleep(
    {
      // A failed pass sleeps as if idle, so a broken provider isn't retried every few minutes.
      requestedMinutes: error ? hd.idleSleepMinutes : outcome.sleepMinutes,
      withinWorkingHours,
      allWaiting: awake.every((s) => s.status !== "active"),
      userAway: minutesSinceUserReplied >= hd.userAwayAfterMinutes,
    },
    hd,
  );
  const sleepReason = outcome.reason ? `${outcome.reason} (${sleep.reason})` : sleep.reason;
  await finishPass(db, pass.id, {
    notes: outcome.notes,
    sleepMinutes: sleep.minutes,
    sleepReason,
    error: error ?? (outcome.finished ? null : "the pass ended without calling finish_pass"),
  });
  publish({
    type: "pass-finished",
    passId: pass.id,
    sleepMinutes: sleep.minutes,
    nextPassAt: new Date(Date.now() + sleep.minutes * 60_000).toISOString(),
  });
  return { passId: pass.id, sleepMinutes: sleep.minutes, sleepReason };
}
