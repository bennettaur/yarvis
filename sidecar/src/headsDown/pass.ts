import type { LanguageModel } from "ai";
import { runAgentTurn } from "../chat/agent.ts";
import { builtinToolMetadataByFamily } from "../chat/builtinTools.ts";
import { getChatBudget } from "../chat/config.ts";
import { addMessage as addChatMessage, createSession, getMessages } from "../chat/service.ts";
import { MAX_REQUEST_CHARS } from "../chat/toolReview.ts";
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
import { type AttemptRecord, newAttemptRecord, recordEvent } from "./passRecord.ts";
import { buildPassTools, newPassOutcome } from "./passTools.ts";
import { PASS_CONFIRMED_TOOLS, passApprovalHooks } from "./policy.ts";
import { buildPassPrompt, buildRetryPrompt, PASS_INSTRUCTIONS } from "./prompt.ts";
import {
  answeredSince,
  earlierMessages,
  finishPass,
  getActiveRun,
  lastFinishedPass,
  lastUserActivityAt,
  listQuestions,
  markMessagesSeen,
  passToolCalls,
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
  // The reviewer reads only so much, and keeps the start. The focus goes
  // first, then as many messages as fit, newest kept: the latest instruction
  // ("stop posting in #billing") is the one that must not be cut.
  const focus = run.focus ? run.focus.slice(0, MAX_REQUEST_CHARS / 2) : null;
  let budget = MAX_REQUEST_CHARS - (focus?.length ?? 0);
  const kept: string[] = [];
  const newestFirst = [...messages].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  for (const message of newestFirst) {
    if (message.body.length + 2 > budget) break;
    kept.unshift(message.body);
    budget -= message.body.length + 2;
  }
  return [focus, ...kept].filter(Boolean).join("\n\n");
}

/** The sleep reason recorded for a pass the user stopped; the page shows it as stopped. */
export const STOPPED_BY_USER = "stopped by you";

/** How long a pass may run before it is stopped. */
export const PASS_TIMEOUT_MS = 20 * 60_000;

const TIMED_OUT = `ran out of time after ${PASS_TIMEOUT_MS / 60_000} minutes`;

/**
 * Retries per model call on a rate limit or server error, on top of the first
 * try. The AI SDK backs off 2s, 4s, 8s…, so five covers about a minute of a
 * provider shedding load.
 */
const PASS_MODEL_RETRIES = 5;

/**
 * How long to wait before picking a pass up again after the provider failed it
 * mid-stream, where the AI SDK doesn't retry. One entry per retry.
 */
const PASS_RETRY_DELAYS_MS = [30_000, 120_000];

/** Resolves after `ms`, or as soon as `signal` aborts. */
function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
  });
}

/**
 * Saves what a turn did when it ended without saving it itself, which a turn
 * that fails or is stopped never does. Without this a pass that failed after
 * twenty calls shows nothing at all.
 */
async function keepAttempt(
  db: Db,
  sessionId: string,
  record: AttemptRecord,
  ending: string,
): Promise<void> {
  if (record.activity.length === 0 && !record.text.trim()) return;
  const messages = await getMessages(db, sessionId);
  if (messages.at(-1)?.role === "assistant") return;
  await addChatMessage(db, {
    sessionId,
    role: "assistant",
    content: [record.text.trim(), `(${ending})`].filter(Boolean).join("\n\n"),
    toolCalls: record.activity,
  });
}

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
 * `model` replaces the configured one and `retryDelaysMs` the waits between
 * retries, for tests.
 */
export async function runPass(
  config: Config,
  db: Db,
  run: HeadsDownRun,
  options: { model?: LanguageModel; retryDelaysMs?: readonly number[] } = {},
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
  // A failed pass left no notes, so this one is told what it got through instead.
  const lastFailure =
    last?.error && last.chatSessionId
      ? { error: last.error, activity: await passToolCalls(db, last.chatSessionId) }
      : null;

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
  let attempt = newAttemptRecord();
  const timedOut = () => abort.signal.aborted && !stoppedByUser;
  const ending = (e: string) =>
    stoppedByUser
      ? "Stopped by you here."
      : timedOut()
        ? "Ran out of time here."
        : `Failed here: ${e}`;
  try {
    // Stopped while the pass was getting ready: its abort wasn't registered yet.
    if ((await getActiveRun(db))?.id !== run.id) {
      stoppedByUser = true;
      throw new Error("stopped before it started");
    }
    const userRequest = userRequestFor(run, [...earlier, ...messages]);
    const { model, budget } = options.model
      ? { model: options.model, budget: undefined }
      : await passModel(config, headsDownConfig);
    mountTools(session.id, passToolIds());
    let message = buildPassPrompt({
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
      lastFailure,
    });
    // Every call made this pass, across retries, for the retry prompt.
    const made: AttemptRecord["activity"] = [];
    for (let retry = 0; ; retry++) {
      error = null;
      attempt = newAttemptRecord();
      let transient = false;
      for await (const event of runAgentTurn({
        config,
        db,
        model,
        sessionId: session.id,
        message,
        userMetadata: { source: "heads-down" },
        signal: abort.signal,
        approval: passApprovalHooks(
          db,
          run,
          changed,
          // With nothing the user said this run, no call can be shown to fit it.
          userRequest
            ? {
                config,
                db,
                userRequest,
                signal: abort.signal,
              }
            : undefined,
        ),
        confirmBuiltins: PASS_CONFIRMED_TOOLS,
        instructions: PASS_INSTRUCTIONS,
        extraTools: buildPassTools(db, outcome, changed),
        budget,
        maxRetries: PASS_MODEL_RETRIES,
      })) {
        promptSent = true;
        publish({ type: "pass-event", passId: pass.id, event });
        recordEvent(attempt, event);
        if (event.type === "error") {
          error = event.message;
          transient = event.transient === true;
        }
      }
      made.push(...attempt.activity);
      if (error === null) break;
      await keepAttempt(db, session.id, attempt, ending(error));
      const delay = (options.retryDelaysMs ?? PASS_RETRY_DELAYS_MS)[retry];
      if (outcome.finished || abort.signal.aborted || !transient || delay === undefined) break;
      console.warn(`[heads-down] pass hit a provider error, retrying in ${delay / 1000}s:`, error);
      await wait(delay, abort.signal);
      if (abort.signal.aborted) break;
      message = buildRetryPrompt(error, made);
    }
  } catch (e) {
    error = e instanceof Error ? e.message : String(e);
    console.error("[heads-down] pass failed:", error);
    await keepAttempt(db, session.id, attempt, ending(error)).catch((saveError) =>
      console.error("[heads-down] saving the failed pass's transcript failed:", saveError),
    );
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
  // The turn reports a timeout as a plain stop, which reads as the user's doing.
  else if (timedOut()) error = TIMED_OUT;
  else error ??= "the pass ended without calling finish_pass";
  // The pass is recorded whatever happens here: a failure to read the streams
  // just loses the idle reasons, not the record.
  const awake = await listStreams(db, { awakeAt: new Date() }).catch((e) => {
    console.error("[heads-down] reading streams for the sleep failed:", e);
    return null;
  });
  const sleep = chooseSleep(
    {
      // A failed pass sleeps as if idle, so a broken provider isn't retried every few minutes.
      requestedMinutes: error ? headsDownConfig.idleSleepMinutes : outcome.sleepMinutes,
      withinWorkingHours,
      // A stream that is active but snoozed (wakeAt ahead) can't be pushed now either.
      openStreams: awake?.length ?? 0,
      allWaiting: awake?.every((s) => s.status !== "active") ?? true,
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
