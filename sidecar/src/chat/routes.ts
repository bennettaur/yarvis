import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { availableProviders, resolveModel } from "../llm/providers.ts";
import { runAgentTurn } from "./agent.ts";
import { createSession, getMessages, listSessions } from "./service.ts";

// Re-exported from the shared agent module so the existing context test (which
// imports it from here) keeps passing and callers have one import surface.
export { buildScreenContextMessage } from "./agent.ts";

const chatSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  context: z.string().max(8000).optional(),
});

const createSessionSchema = z.object({ title: z.string().nullish() });

/** Chat routes, mounted under /api/chat. */
export function createChatRoutes(config: Config): Hono {
  const router = new Hono();

  router.get("/providers", async (c) => {
    const db = config.databaseUrl ? getDb(config.databaseUrl).db : undefined;
    return c.json(await availableProviders(config, db));
  });

  // Routes below need a database.
  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/sessions", async (c) => c.json(await listSessions(db())));

  router.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createSession(db(), parsed.data.title), 201);
  });

  router.get("/sessions/:id/messages", async (c) =>
    c.json(await getMessages(db(), c.req.param("id"))),
  );

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { sessionId, message, provider, model, context } = parsed.data;

    const dbh = db();
    let chatModel;
    try {
      chatModel = await resolveModel(config, dbh, provider, model);
    } catch (e) {
      console.error("[chat] model resolution failed:", e);
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    return streamSSE(c, async (stream) => {
      // The agent yields delta/attention/error/done events; map each onto the
      // SSE wire protocol the frontend consumes. `done.text` is ignored here
      // because the deltas already carried the full reply to the client.
      for await (const event of runAgentTurn({
        config,
        db: dbh,
        model: chatModel,
        sessionId,
        message,
        context,
        // Cancel the upstream call if the client disconnects.
        signal: c.req.raw.signal,
      })) {
        if (event.type === "delta") {
          await stream.writeSSE({ data: JSON.stringify({ type: "delta", text: event.text }) });
        } else if (event.type === "attention") {
          await stream.writeSSE({
            data: JSON.stringify({ type: "attention", reason: event.reason }),
          });
        } else if (event.type === "error") {
          await stream.writeSSE({
            data: JSON.stringify({ type: "error", message: event.message }),
          });
        } else if (event.type === "done") {
          await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
        }
      }
    });
  });

  return router;
}
