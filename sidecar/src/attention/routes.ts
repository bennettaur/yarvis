import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type AttentionNavTarget, workspaces } from "../db/schema.ts";
import { type AttentionStreamEvent, publish, subscribe } from "./hub.ts";
import {
  type AttentionKind,
  type AttentionStatus,
  createAttention,
  listAttention,
  updateAttentionStatus,
} from "./service.ts";

const KIND = z.enum(["permission", "idle", "completed", "error", "info"]);

/** Cap on a single stream's pending-write queue, so a stalled reader is bounded. */
const MAX_STREAM_QUEUE = 256;

/**
 * Body a Claude Code hook posts. Only safe, literal values (a uuid, the
 * "ws-claude:<uuid>" key, a fixed kind) are baked into the per-workspace
 * `.claude/settings.json` command — no user-controlled strings — so there is no
 * shell/JSON escaping to get wrong. The display title is looked up from the
 * workspace here instead.
 */
export const ingestSchema = z.object({
  workspaceId: z.string().min(1),
  sessionKey: z.string().min(1),
  kind: KIND,
  hookEvent: z.string().optional(),
});

/** A human summary for each kind, used when the hook carries no message. */
function defaultBody(kind: AttentionKind): string {
  switch (kind) {
    case "permission":
      return "Needs permission to continue";
    case "idle":
      return "Waiting for your input";
    case "completed":
      return "Finished — ready for you";
    case "error":
      return "Hit an error";
    case "info":
      return "Wants your attention";
  }
}

/**
 * Attention-ingest, mounted at `/ingest` OUTSIDE the main bearer wall. Its own
 * middleware accepts only the scoped attention token, and it can only create
 * attention items — so a Claude session shell holding that token can raise a
 * flag without gaining access to the rest of the API.
 */
export function createAttentionIngestRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.attentionToken }));

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.post("/attention", async (c) => {
    const parsed = ingestSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { workspaceId, sessionKey, kind } = parsed.data;

    const [ws] = await db()
      .select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));

    const navTarget: AttentionNavTarget = { type: "workspace-claude", workspaceId };
    const item = await createAttention(db(), {
      source: "claude-hook",
      sessionKey,
      workspaceId,
      kind,
      title: ws?.name ?? "Claude session",
      body: defaultBody(kind),
      navTarget,
      payload: parsed.data,
    });
    publish(item);
    return c.json({ id: item.id }, 201);
  });

  return router;
}

const patchSchema = z.object({
  status: z.enum(["read", "resolved", "dismissed"]),
});

/** Heartbeat interval so proxies/keep-alive don't drop an idle stream. */
const HEARTBEAT_MS = 25_000;

/**
 * Read + mutate routes for the webview, mounted under `/api/attention` behind the
 * main bearer. `GET /` hydrates the current list, `GET /stream` delivers live
 * deltas over SSE, `PATCH /:id` moves an item through its lifecycle.
 */
export function createAttentionRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  const parseStatus = (value: string | undefined): AttentionStatus | undefined =>
    value === "pending" || value === "read" || value === "resolved" || value === "dismissed"
      ? value
      : undefined;

  // Supports ?status=<status>. Newest-first.
  router.get("/", async (c) => {
    const items = await listAttention(db(), { status: parseStatus(c.req.query("status")) });
    return c.json(items);
  });

  // Live stream: forwards each item as it is published. A client that misses
  // events while disconnected recovers by re-hydrating from `GET /` on reconnect,
  // so the stream itself is purely forward — no replay/backfill.
  router.get("/stream", async (c) => {
    return streamSSE(c, async (stream) => {
      // Bridge published rows into this stream via a bounded queue drained below.
      // The cap drops the oldest if a client stops reading, so a stalled consumer
      // can't grow this without limit.
      const queue: AttentionStreamEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe((item) => {
        queue.push({ type: "item", item });
        if (queue.length > MAX_STREAM_QUEUE) queue.shift();
        wake?.();
      });

      const signal = c.req.raw.signal;

      // Resolves true when a new item is queued, false on heartbeat timeout or
      // abort. Cleans up its own timer + listener so nothing dangles.
      const waitForItemOrHeartbeat = () =>
        new Promise<boolean>((resolve) => {
          let settled = false;
          const finish = (value: boolean) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            signal.removeEventListener("abort", onAbort);
            wake = null;
            resolve(value);
          };
          const timer = setTimeout(() => finish(false), HEARTBEAT_MS);
          const onAbort = () => finish(false);
          signal.addEventListener("abort", onAbort, { once: true });
          wake = () => finish(true);
        });

      try {
        while (!signal.aborted) {
          while (queue.length > 0) {
            await stream.writeSSE({ data: JSON.stringify(queue.shift()) });
          }
          if (signal.aborted) break;
          const gotItem = await waitForItemOrHeartbeat();
          if (signal.aborted) break;
          if (!gotItem) {
            await stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });
          }
        }
      } finally {
        unsubscribe();
      }
    });
  });

  router.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const row = await updateAttentionStatus(db(), c.req.param("id"), parsed.data.status);
    if (!row) return c.json({ error: "not found" }, 404);
    publish(row);
    return c.json(row);
  });

  return router;
}
