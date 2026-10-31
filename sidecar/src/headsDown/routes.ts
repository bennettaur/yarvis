import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { getMessages } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { settleQuestionAttention } from "./attention.ts";
import { getHeadsDownConfig, MAX_PASS_TIMEOUT_MINUTES, saveHeadsDownConfig } from "./config.ts";
import {
  clearHeadsDown,
  NOT_RUNNING,
  parseStopTime,
  pauseHeadsDown,
  resumeHeadsDown,
  setHeadsDownStopTime,
  startHeadsDown,
  stopHeadsDown,
} from "./control.ts";
import { type HeadsDownStreamEvent, publish, subscribe } from "./hub.ts";
import {
  addMessage,
  answerQuestion,
  dismissQuestion,
  getActiveRun,
  getPass,
  lastFinishedPass,
  listAutoApprovals,
  listMessages,
  listPasses,
  listQuestions,
  listUnattendedTools,
  passCallSummaries,
  setToolUnattended,
} from "./service.ts";
import { wakeHeadsDown } from "./wake.ts";

/**
 * Routes for the Heads down page, mounted under /api/heads-down: turn the
 * loop on and off, read what each pass did, leave it messages, and answer its
 * questions.
 */

const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

/** A stalled page can't grow the stream's queue without limit. */
const MAX_STREAM_QUEUE = 500;
const HEARTBEAT_MS = 25_000;

/** A page of rules at most: every pass carries the guidance in its prompt. */
const MAX_GUIDANCE_CHARS = 4000;

const configSchema = z
  .object({
    minSleepMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    maxSleepMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    idleSleepMinutes: z
      .number()
      .int()
      .min(1)
      .max(24 * 60),
    workingHours: z
      .object({
        days: z.array(z.number().int().min(0).max(6)).max(7),
        start: z.string().regex(HHMM),
        end: z.string().regex(HHMM),
      })
      .nullable(),
    userAwayAfterMinutes: z
      .number()
      .int()
      .min(1)
      .max(7 * 24 * 60),
    // Optional so a client that doesn't know about it can still save the rest
    // without resetting it.
    passTimeoutMinutes: z.number().int().min(1).max(MAX_PASS_TIMEOUT_MINUTES).optional(),
    provider: z.string().min(1).nullable(),
    model: z.string().min(1).nullable(),
    // Optional so a client that doesn't know about it can still save the rest.
    guidance: z
      .string()
      .trim()
      .max(MAX_GUIDANCE_CHARS)
      .transform((g) => g || null)
      .nullable()
      .default(null),
  })
  .refine((c) => c.minSleepMinutes <= c.maxSleepMinutes, "min sleep must not exceed max sleep")
  .refine((c) => c.idleSleepMinutes <= c.maxSleepMinutes, "idle sleep must not exceed max sleep");

/** A stop time as an ISO timestamp with an offset, or a local "HH:MM" (see `parseStopTime`). */
const stopAtSchema = z.string().transform((s, ctx) => {
  const at = parseStopTime(s);
  if (!at) ctx.addIssue({ code: "custom", message: "give an ISO timestamp or HH:MM" });
  return at ?? z.NEVER;
});

const startSchema = z.object({
  focus: z.string().trim().max(2000).optional(),
  stopAt: stopAtSchema.nullable().optional(),
});

const answerSchema = z
  .object({
    choice: z.string().min(1).max(80).optional(),
    answer: z.string().min(1).max(4000).optional(),
  })
  .refine((a) => a.choice || a.answer, "give a choice or an answer");

export function createHeadsDownRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;
  const changed = () => publish({ type: "changed" });

  router.get("/", async (c) => {
    const [run, questions] = await Promise.all([getActiveRun(db()), listQuestions(db())]);
    // This run's last pass: a pass from an earlier run says nothing about when this one looks next.
    const last = run ? await lastFinishedPass(db(), run.id) : null;
    const nextPass =
      run && run.pausedAt === null && last?.finishedAt && last.sleepMinutes !== null
        ? new Date(last.finishedAt.getTime() + last.sleepMinutes * 60_000)
        : null;
    // A pass due after the stop time never runs: the run stops first.
    const nextPassAt =
      nextPass && !(run?.stopAt && run.stopAt <= nextPass) ? nextPass.toISOString() : null;
    return c.json({ run, lastPass: last, nextPassAt, openQuestionCount: questions.length });
  });

  router.post("/start", async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const run = await startHeadsDown(db(), parsed.data.focus || null, {
      stopAt: parsed.data.stopAt,
    });
    if ("error" in run) return c.json({ error: run.error }, 400);
    return c.json(run);
  });

  router.post("/stop", async (c) => {
    const run = await stopHeadsDown(db());
    return c.json({ stopped: run !== null });
  });

  router.post("/pause", async (c) => {
    const run = await pauseHeadsDown(db());
    if (!run) return c.json({ error: NOT_RUNNING }, 409);
    return c.json(run);
  });

  router.post("/resume", async (c) => {
    const run = await resumeHeadsDown(db());
    if (!run) return c.json({ error: "heads-down mode isn't paused" }, 409);
    return c.json(run);
  });

  router.put("/stop-at", async (c) => {
    const parsed = z
      .object({ stopAt: stopAtSchema.nullable() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const run = await setHeadsDownStopTime(db(), parsed.data.stopAt);
    if ("error" in run) return c.json({ error: run.error }, run.error === NOT_RUNNING ? 409 : 400);
    return c.json(run);
  });

  router.post("/clear", async (c) => {
    const result = await clearHeadsDown(db());
    if ("error" in result) return c.json(result, 409);
    return c.json(result);
  });

  router.get("/config", async (c) => c.json(await getHeadsDownConfig()));

  router.put("/config", async (c) => {
    const parsed = configSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const passTimeoutMinutes =
      parsed.data.passTimeoutMinutes ?? (await getHeadsDownConfig()).passTimeoutMinutes;
    return c.json(await saveHeadsDownConfig({ ...parsed.data, passTimeoutMinutes }));
  });

  // MCP tools heads-down mode may call without asking. Kept with the tool's
  // other consent in Postgres, and reset with it when the tool changes.
  router.get("/allowed-tools", async (c) => c.json(await listUnattendedTools(db())));

  router.put("/allowed-tools/:id", async (c) => {
    const parsed = z
      .object({ allowed: z.boolean() })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const ok = await setToolUnattended(db(), c.req.param("id"), parsed.data.allowed);
    if (!ok) return c.json({ error: "no MCP tool with that id" }, 404);
    return c.json({ id: c.req.param("id"), allowed: parsed.data.allowed });
  });

  // Calls the decision model approved on the user's behalf, so they can see what ran without them.
  router.get("/auto-approvals", async (c) => c.json(await listAutoApprovals(db())));

  // Each pass with how many calls it made and which failed, so a failure reads without opening it.
  router.get("/passes", async (c) => {
    const passes = await listPasses(db(), 50);
    const summaries = await passCallSummaries(
      db(),
      passes.flatMap((p) => (p.chatSessionId ? [p.chatSessionId] : [])),
    );
    return c.json(
      passes.map((p) => ({
        ...p,
        ...((p.chatSessionId && summaries.get(p.chatSessionId)) || {
          callCount: 0,
          failedCalls: [],
        }),
      })),
    );
  });

  // A pass with its transcript: the hidden chat session it ran in.
  router.get("/passes/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const pass = await getPass(db(), id);
    if (!pass) return c.json({ error: "not found" }, 404);
    const messages = pass.chatSessionId ? await getMessages(db(), pass.chatSessionId) : [];
    return c.json({ pass, messages });
  });

  router.get("/messages", async (c) => c.json(await listMessages(db())));

  router.post("/messages", async (c) => {
    const parsed = z
      .object({ body: z.string().trim().min(1).max(4000) })
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const message = await addMessage(db(), parsed.data.body);
    changed();
    wakeHeadsDown();
    return c.json(message, 201);
  });

  router.get("/questions", async (c) => {
    const status = c.req.query("status");
    const statuses =
      status === "all" ? (["open", "answered", "dismissed"] as const) : (["open"] as const);
    return c.json(await listQuestions(db(), { statuses, limit: 100 }));
  });

  router.post("/questions/:id/answer", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const memory = new PgVectorMemoryStore(db(), await chooseEmbedder(config, db()));
    const result = await answerQuestion(db(), memory, id, parsed.data);
    if ("error" in result) return c.json(result, 409);
    await settleQuestionAttention(db(), id);
    changed();
    wakeHeadsDown();
    return c.json(result);
  });

  router.post("/questions/:id/dismiss", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id) || !(await dismissQuestion(db(), id))) {
      return c.json({ error: "no open question with that id" }, 404);
    }
    await settleQuestionAttention(db(), id);
    changed();
    return c.json({ dismissed: true });
  });

  // Live updates for the page. Forward only: a page that reconnects re-reads
  // the routes above.
  router.get("/stream", async (c) =>
    streamSSE(c, async (stream) => {
      const queue: HeadsDownStreamEvent[] = [];
      let notify: (() => void) | null = null;
      const unsubscribe = subscribe((event) => {
        queue.push(event);
        if (queue.length > MAX_STREAM_QUEUE) queue.shift();
        notify?.();
      });
      const signal = c.req.raw.signal;
      const waitForEvent = () =>
        new Promise<boolean>((resolve) => {
          const done = (value: boolean) => {
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            notify = null;
            resolve(value);
          };
          const timer = setTimeout(() => done(false), HEARTBEAT_MS);
          const onAbort = () => done(false);
          signal.addEventListener("abort", onAbort, { once: true });
          notify = () => done(true);
        });
      try {
        while (!signal.aborted) {
          while (queue.length > 0) {
            await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          }
          if (signal.aborted) break;
          if (!(await waitForEvent()) && !signal.aborted) {
            await stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });
          }
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  return router;
}
