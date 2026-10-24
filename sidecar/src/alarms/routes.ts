import { type Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type AlarmStreamEvent, subscribe } from "./hub.ts";
import {
  acknowledgeAlarm,
  cancelAlarm,
  createAlarm,
  isAlarmChangeError,
  listAlarms,
  snoozeAlarm,
  toAlarm,
} from "./service.ts";

/** Routes for the alarm list, mounted under /api/alarms. */

const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

/** A stalled page can't grow the stream's queue without limit. */
const MAX_STREAM_QUEUE = 100;
const HEARTBEAT_MS = 25_000;

const createSchema = z.object({
  label: z.string().trim().min(1).max(300),
  fireAtMs: z.number().int().positive(),
  sound: z.boolean().optional(),
  // Opened by the Join button, so only a web link.
  meetLink: z
    .string()
    .url()
    .max(2000)
    .refine((u) => /^https?:\/\//i.test(u), "meetLink must be an http(s) link")
    .nullable()
    .optional(),
});

const snoozeSchema = z.object({
  minutes: z
    .number()
    .int()
    .min(1)
    .max(24 * 60),
});

export function createAlarmRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json((await listAlarms(db())).map(toAlarm)));

  router.post("/", async (c) => {
    const parsed = createSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
    const row = await createAlarm(db(), {
      label: parsed.data.label,
      fireAt: new Date(parsed.data.fireAtMs),
      sound: parsed.data.sound,
      meetLink: parsed.data.meetLink ?? null,
      source: "app",
    });
    return c.json(toAlarm(row), 201);
  });

  const NOT_FOUND = { error: "no alarm with that id" };

  const respond = (c: Context, result: Awaited<ReturnType<typeof acknowledgeAlarm>> | null) => {
    if (!result) return c.json(NOT_FOUND, 404);
    if (!isAlarmChangeError(result)) return c.json(toAlarm(result));
    if (result.error === "not-found") return c.json(NOT_FOUND, 404);
    return c.json({ error: `the alarm is already ${result.status}` }, 409);
  };

  router.post("/:id/acknowledge", async (c) => {
    const id = c.req.param("id");
    return respond(c, UUID.test(id) ? await acknowledgeAlarm(db(), id) : null);
  });

  router.post("/:id/cancel", async (c) => {
    const id = c.req.param("id");
    return respond(c, UUID.test(id) ? await cancelAlarm(db(), id) : null);
  });

  router.post("/:id/snooze", async (c) => {
    const id = c.req.param("id");
    const parsed = snoozeSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.issues[0]?.message }, 400);
    return respond(c, UUID.test(id) ? await snoozeAlarm(db(), id, parsed.data.minutes) : null);
  });

  // Live updates. Forward only: a page that reconnects re-reads the list.
  router.get("/stream", async (c) =>
    streamSSE(c, async (stream) => {
      const queue: AlarmStreamEvent[] = [];
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
