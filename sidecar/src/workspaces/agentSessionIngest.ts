import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { workspaces } from "../db/schema.ts";
import {
  recordAgentSessionEnd,
  recordAgentSessionStart,
  sessionKeyBelongsTo,
} from "./agentSessions.ts";

/** Header carrying the PTY id, from the session's `YARVIS_SESSION_KEY`. */
export const SESSION_KEY_HEADER = "X-Yarvis-Session-Key";

/** Same bound the attention ingest puts on a session key. */
const MAX_SESSION_KEY = 256;

const querySchema = z.object({
  workspaceId: z
    .string()
    .regex(/^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/, "must be a uuid"),
  pid: z.coerce.number().int().positive().max(2_147_483_647),
});

/**
 * The fields used from Claude Code's own hook input, which the hook forwards
 * unchanged. Everything else in it (transcript path, cwd, cost estimates) is
 * dropped by the parse.
 */
const hookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd"]),
  session_id: z.string().min(1).max(128),
  source: z.string().max(32).optional(),
  reason: z.string().max(32).optional(),
});

/**
 * Agent-session ingest, mounted at `/ingest/agent-session` outside the main
 * bearer wall like attention-ingest, and on the same scoped token: the hooks run
 * in the session's shell, which holds only that token. All it can do is record
 * that a Claude session in one of a workspace's own PTYs started or ended.
 */
export function createAgentSessionIngestRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.attentionToken }));

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.post("/", async (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.flatten() }, 400);
    const input = hookInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: input.error.flatten() }, 400);
    const sessionKey = c.req.header(SESSION_KEY_HEADER) ?? "";
    if (sessionKey.length > MAX_SESSION_KEY) {
      return c.json({ error: "session key too long" }, 400);
    }

    const { workspaceId, pid } = query.data;
    if (!sessionKeyBelongsTo(sessionKey, workspaceId)) {
      return c.json({ error: "session key does not belong to that workspace" }, 400);
    }
    const [ws] = await db()
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId));
    if (!ws) return c.json({ error: "workspace not found" }, 404);

    const { hook_event_name, session_id, source, reason } = input.data;
    if (hook_event_name === "SessionStart") {
      await recordAgentSessionStart(db(), {
        workspaceId,
        sessionKey,
        claudeSessionId: session_id,
        pid,
        source: source ?? null,
      });
    } else {
      await recordAgentSessionEnd(db(), {
        sessionKey,
        claudeSessionId: session_id,
        reason: reason ?? null,
      });
    }
    return c.body(null, 204);
  });

  return router;
}
