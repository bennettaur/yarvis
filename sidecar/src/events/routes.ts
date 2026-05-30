import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { EVENT_TYPES, listEvents, recordEvent } from "./service.ts";

/**
 * Generic ingestion for frontend-sourced events (e.g. a PR viewed, an alarm
 * created). Backend actions emit directly via the events service; this endpoint
 * exists for events that originate in the UI or Rust core, which reach the
 * sidecar over HTTP. The `type` is restricted to a known allowlist so callers
 * can't fill the log with arbitrary types.
 */

const postSchema = z.object({
  type: z.enum(EVENT_TYPES),
  source: z.string().min(1).optional(),
  payload: z.record(z.unknown()).optional(),
  // Accept an ISO timestamp for backfilled events; defaults to now otherwise.
  occurredAt: z.string().datetime().optional(),
});

/** Event log routes, mounted under /api/events. */
export function createEventRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.post("/", async (c) => {
    const parsed = postSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await recordEvent(db(), {
      type: parsed.data.type,
      source: parsed.data.source,
      payload: parsed.data.payload,
      occurredAt: parsed.data.occurredAt
        ? new Date(parsed.data.occurredAt)
        : undefined,
    });
    return c.json(row, 201);
  });

  router.get("/", async (c) => {
    const typeParam = c.req.query("type");
    if (typeParam && !(EVENT_TYPES as readonly string[]).includes(typeParam)) {
      return c.json({ error: "unknown type" }, 400);
    }
    const limit = Number(c.req.query("limit") ?? "100");
    const sinceParam = c.req.query("since");
    const since = sinceParam ? new Date(sinceParam) : undefined;
    const records = await listEvents(db(), {
      type: typeParam as (typeof EVENT_TYPES)[number] | undefined,
      since: since && !Number.isNaN(since.getTime()) ? since : undefined,
      unprocessedOnly: c.req.query("unprocessed") === "true",
      limit: Number.isFinite(limit) ? limit : 100,
    });
    return c.json(records);
  });

  return router;
}
