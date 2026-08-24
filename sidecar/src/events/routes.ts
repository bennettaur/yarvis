import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { EVENT_TYPES, type EventType, isEventType, pageEvents, recordEvent } from "./service.ts";

/** Upper bound on a single list response, so the log can't be read whole. */
const MAX_LIMIT = 1000;

/** Longest free-text filter accepted; a longer one is a paste, not a query. */
const MAX_SEARCH_CHARS = 200;

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
  payload: z.record(z.string(), z.unknown()).optional(),
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
      occurredAt: parsed.data.occurredAt ? new Date(parsed.data.occurredAt) : undefined,
    });
    return c.json(row, 201);
  });

  // The set of known types, so the events browser can offer them as filters
  // without hardcoding a copy of the allowlist.
  router.get("/types", (c) => c.json({ types: EVENT_TYPES }));

  /**
   * Supports ?type= (repeatable), ?since=/?until=<ISO>, ?q=<substring>,
   * ?unprocessed=true, ?limit= (clamped) and ?offset=. Answers with the page
   * plus the total match count, since the browser paginates.
   */
  router.get("/", async (c) => {
    const typeParams = c.req.queries("type") ?? [];
    const types: EventType[] = [];
    for (const t of typeParams) {
      if (!isEventType(t)) return c.json({ error: "unknown type" }, 400);
      types.push(t);
    }
    const rawLimit = Number(c.req.query("limit") ?? "100");
    const limit = Number.isInteger(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : 100;
    const rawOffset = Number(c.req.query("offset") ?? "0");
    const offset = Number.isInteger(rawOffset) && rawOffset >= 0 ? rawOffset : 0;
    const parseInstant = (raw: string | undefined): Date | undefined => {
      if (!raw) return undefined;
      const parsed = new Date(raw);
      return Number.isNaN(parsed.getTime()) ? undefined : parsed;
    };
    const search = c.req.query("q")?.slice(0, MAX_SEARCH_CHARS);

    const page = await pageEvents(db(), {
      types,
      since: parseInstant(c.req.query("since")),
      until: parseInstant(c.req.query("until")),
      search,
      unprocessedOnly: c.req.query("unprocessed") === "true",
      limit,
      offset,
    });
    return c.json({ ...page, limit, offset });
  });

  return router;
}
