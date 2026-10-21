import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  getQuestion,
  listPendingQuestions,
  type ReplyOutcome,
  replyToQuestion,
} from "./service.ts";

const UUID = z
  .string()
  .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid");

const answerSchema = z.object({
  // Bounds match what `ask_user` accepts: up to 4 questions of up to 6 options.
  answers: z
    .array(
      z.object({
        selected: z.array(z.string().max(80)).max(6),
        text: z.string().max(4000).optional(),
      }),
    )
    .max(4),
});

const STATUS_FOR: Record<Exclude<ReplyOutcome, { ok: true }>["reason"], 404 | 409 | 400> = {
  "not-found": 404,
  "not-pending": 409,
  invalid: 400,
};

/**
 * Routes the answer dialog uses, mounted under `/api/questions` behind the main
 * bearer. The agent side asks and waits over MCP (`mcpServer/questionTools.ts`);
 * this side reads what was asked and replies.
 */
export function createQuestionRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  // ?sessionKey=<key> lists that session's pending questions.
  router.get("/", async (c) => {
    const sessionKey = c.req.query("sessionKey");
    if (!sessionKey) return c.json({ error: "sessionKey is required" }, 400);
    return c.json(await listPendingQuestions(db(), sessionKey));
  });

  router.get("/:id", async (c) => {
    const id = UUID.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "must be a uuid" }, 400);
    const row = await getQuestion(db(), id.data);
    return row ? c.json(row) : c.json({ error: "not found" }, 404);
  });

  router.post("/:id/answer", async (c) => {
    const id = UUID.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "must be a uuid" }, 400);
    const parsed = answerSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const result = await replyToQuestion(db(), id.data, {
      status: "answered",
      answers: parsed.data.answers,
    });
    if (!result.ok) return c.json({ error: result.message }, STATUS_FOR[result.reason]);
    return c.json(result.row);
  });

  router.post("/:id/decline", async (c) => {
    const id = UUID.safeParse(c.req.param("id"));
    if (!id.success) return c.json({ error: "must be a uuid" }, 400);
    const result = await replyToQuestion(db(), id.data, { status: "declined" });
    if (!result.ok) return c.json({ error: result.message }, STATUS_FOR[result.reason]);
    return c.json(result.row);
  });

  return router;
}
