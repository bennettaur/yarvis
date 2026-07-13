import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { type AttentionNavTarget, workspaces } from "../db/schema.ts";
import { publish, subscribe } from "./hub.ts";
import {
  type AttentionKind,
  createAttention,
  listAttention,
  updateAttentionStatus,
} from "./service.ts";

const KIND = z.enum(["permission", "idle", "completed", "error", "info"]);

/**
 * Body a Claude Code hook posts. Only safe, literal values (a uuid, the
 * "ws-claude:<uuid>" key, a fixed kind) are baked into the per-workspace
 * `.claude/settings.json` command — no user-controlled strings — so there is no
 * shell/JSON escaping to get wrong. The display title is looked up from the
 * workspace here instead.
 */
const ingestSchema = z.object({
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

  // Supports ?status=<status>&since=<seq>&limit=. Newest-first.
  router.get("/", async (c) => {
    const statusParam = c.req.query("status");
    const status =
      statusParam === "pending" ||
      statusParam === "read" ||
      statusParam === "resolved" ||
      statusParam === "dismissed"
        ? statusParam
        : undefined;
    const sinceRaw = c.req.query("since");
    const since =
      sinceRaw !== undefined && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;
    const items = await listAttention(db(), { status, since });
    return c.json(items);
  });

  // Live stream. Optionally replays pending items with seq > `since` first (a
  // reconnect backfill), then forwards new items as they are published.
  router.get("/stream", async (c) => {
    const sinceRaw = c.req.query("since");
    const since =
      sinceRaw !== undefined && Number.isFinite(Number(sinceRaw)) ? Number(sinceRaw) : undefined;

    return streamSSE(c, async (stream) => {
      if (since !== undefined) {
        const backfill = await listAttention(db(), { status: "pending", since, ascending: true });
        for (const item of backfill) {
          await stream.writeSSE({ data: JSON.stringify({ type: "item", item }) });
        }
      }

      // Bridge published rows into this stream via a queue drained below.
      const queue: unknown[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribe((item) => {
        queue.push({ type: "item", item });
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
