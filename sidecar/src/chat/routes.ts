import { streamText, type ModelMessage } from "ai";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { availableProviders, resolveModel } from "../llm/providers.ts";
import { addMessage, createSession, getMessages, listSessions } from "./service.ts";

const chatSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1),
  provider: z.enum(["anthropic", "bedrock", "gemini"]),
  model: z.string().min(1),
});

const createSessionSchema = z.object({ title: z.string().nullish() });

/** Chat routes, mounted under /api/chat. */
export function createChatRoutes(config: Config): Hono {
  const router = new Hono();

  router.get("/providers", (c) => c.json(availableProviders(config)));

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
    const { sessionId, message, provider, model } = parsed.data;

    let chatModel;
    try {
      chatModel = resolveModel(config, provider, model);
    } catch (e) {
      return c.json({ error: e instanceof Error ? e.message : String(e) }, 400);
    }

    const dbh = db();
    const history = await getMessages(dbh, sessionId);
    await addMessage(dbh, { sessionId, role: "user", content: message });

    const messages: ModelMessage[] = history
      .filter((m) => m.role !== "tool")
      .map((m) => ({
        role: m.role as "user" | "assistant" | "system",
        content: m.content,
      }));
    messages.push({ role: "user", content: message });

    return streamSSE(c, async (stream) => {
      const result = streamText({ model: chatModel, messages });
      let full = "";
      try {
        for await (const delta of result.textStream) {
          full += delta;
          await stream.writeSSE({
            data: JSON.stringify({ type: "delta", text: delta }),
          });
        }
        await addMessage(dbh, { sessionId, role: "assistant", content: full });
        await stream.writeSSE({ data: JSON.stringify({ type: "done" }) });
      } catch (e) {
        await stream.writeSSE({
          data: JSON.stringify({
            type: "error",
            message: e instanceof Error ? e.message : String(e),
          }),
        });
      }
    });
  });

  return router;
}
