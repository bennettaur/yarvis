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
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
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
  earlierMessages,
  finishPass,
  getActiveRun,
  lastFinishedPass,
  lastUserActivityAt,
  listQuestions,
  markMessagesSeen,
  startPass,
  unseenMessages,
  unspentApprovals,
} from "./service.ts";
import { setPassAbort } from "./wake.ts";

/**
 * The built-in families a pass works with, mounted for it so it doesn't spend
 * steps finding them. Anything else (an MCP Slack server, say) it can still
 * search for and mount itself.
 */
const PASS_FAMILIES = ["workStreams", "workspaces", "jira", "prReview", "browser"];

/**
 * What the user asked for in this run, in their own words, for the decision
 * model to judge a call against: the focus and their messages, newest last.
 */
export function userRequestFor(
  run: HeadsDownRun,
  messages: { body: string; createdAt: Date }[],
): string {
  const sorted = [...messages].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  return [run.focus, ...sorted.map((m) => m.body)].filter(Boolean).join("\n\n");
}

/** The sleep reason recorded for a pass the user stopped; the page shows it as stopped. */
export const STOPPED_BY_USER = "stopped by you";

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
  const headsDownConfig = await getHeadsDownConfig();
  const now = new Date();
  const [messages, earlier, last, openQuestions, lastActivity] = await Promise.all([
    unseenMessages(db),
    earlierMessages(db, run.startedAt),
    lastFinishedPass(db, run.id),
    // A question from an earlier run is stale; a long list would crowd out the work.
    listQuestions(db, { since: run.startedAt, limit: 20 }),
    lastUserActivityAt(db, run),
  ]);
  const [answers, approvedCalls] = await Promise.all([
    answeredSince(db, last?.startedAt ?? run.startedAt),
    // The same window decideCall spends grants in: this run, and the last day.
    unspentApprovals(
      db,
      new Date(Math.max(run.startedAt.getTime(), Date.now() - 24 * 60 * 60_000)),
    ),
  ]);
  const withinWorkingHours = isWithinWorkingHours(now, headsDownConfig.workingHours);
  const minutesSinceUserReplied = Math.round((now.getTime() - lastActivity.getTime()) / 60_000);

  const session = await createSession(db, `Heads down · ${now.toISOString()}`, { hidden: true });
  const pass = await startPass(db, run.id, session.id);
  publish({ type: "pass-started", passId: pass.id });

  const outcome = newPassOutcome();
  const changed = () => publish({ type: "changed" });
  let error: string | null = null;
  const abort = new AbortController();
  let stoppedByUser = false;
  const timer = setTimeout(() => abort.abort(), PASS_TIMEOUT_MS);
  setPassAbort(() => {
    stoppedByUser = true;
    abort.abort();
  });
  let promptSent = false;
  try {
    // Stopped while the pass was getting ready: its abort wasn't registered yet.
    if ((await getActiveRun(db))?.id !== run.id) {
      stoppedByUser = true;
      throw new Error("stopped before it started");
    }
    const { model, budget } = options.model
      ? { model: options.model, budget: undefined }
      : await passModel(config, headsDownConfig);
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
        earlierMessages: earlier,
        answers,
        approvedCalls,
        openQuestions,
        lastNotes: last?.notes ?? null,
      }),
      userMetadata: { source: "heads-down" },
      signal: abort.signal,
      approval: passApprovalHooks(db, run, changed, {
        config,
        memory: new PgVectorMemoryStore(db, await chooseEmbedder(config, db)),
        userRequest: userRequestFor(run, [...earlier, ...messages]),
        signal: abort.signal,
      }),
      confirmBuiltins: PASS_CONFIRMED_TOOLS,
      instructions: PASS_INSTRUCTIONS,
      extraTools: buildPassTools(db, outcome, changed),
      budget,
    })) {
      promptSent = true;
      publish({ type: "pass-event", passId: pass.id, event });
      if (event.type === "error") error = event.message;
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("[heads-down] pass failed:", error);
  } finally {
    clearTimeout(timer);
    setPassAbort(null);
    unmountAll(session.id);
    // Seen once a pass has had them in its prompt, even one that failed
    // part-way: re-sending the same instruction every pass would loop on it.
    if (promptSent) {
      await markMessagesSeen(
        db,
        messages.map((m) => m.id),
      ).catch((e) => console.error("[heads-down] marking messages seen failed:", e));
    }
  }

  // Once finish_pass has run, the pass is done: a turn that then ends with no
  // closing text, or fails on a later step, hasn't lost anything.
  // A stop the user asked for is their doing, not a failure.
  if (outcome.finished || stoppedByUser) error = null;
  else if (abort.signal.aborted)
    error ??= `ran out of time after ${PASS_TIMEOUT_MS / 60_000} minutes`;
  else error ??= "the pass ended without calling finish_pass";
  const awake = await listStreams(db, { awakeAt: new Date() });
  const sleep = chooseSleep(
    {
      // A failed pass sleeps as if idle, so a broken provider isn't retried every few minutes.
      requestedMinutes: error ? headsDownConfig.idleSleepMinutes : outcome.sleepMinutes,
      withinWorkingHours,
      // A stream that is active but snoozed (wakeAt ahead) can't be pushed now either.
      openStreams: awake.length,
      allWaiting: awake.every((s) => s.status !== "active"),
      userAway: minutesSinceUserReplied >= headsDownConfig.userAwayAfterMinutes,
    },
    headsDownConfig,
  );
  const sleepReason = stoppedByUser
    ? STOPPED_BY_USER
    : outcome.reason
      ? `${outcome.reason} (${sleep.reason})`
      : sleep.reason;
  await finishPass(db, pass.id, {
    notes: outcome.notes,
    sleepMinutes: sleep.minutes,
    sleepReason,
    error,
  });
  publish({
    type: "pass-finished",
    passId: pass.id,
    sleepMinutes: sleep.minutes,
    nextPassAt: new Date(Date.now() + sleep.minutes * 60_000).toISOString(),
  });
  return { passId: pass.id, sleepMinutes: sleep.minutes, sleepReason };
}
