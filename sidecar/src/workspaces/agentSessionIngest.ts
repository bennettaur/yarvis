import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import { MAX_SESSION_KEY, UUID } from "../attention/routes.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { workspaces } from "../db/schema.ts";
import {
  recordAgentSessionEnd,
  recordAgentSessionStart,
  SESSION_KEY_HEADER,
  SESSION_TOKEN_HEADER,
  sessionKeyBelongsTo,
  sessionTokenMatches,
} from "./agentSessions.ts";

/** Claude's hook input is a few hundred bytes; this only bounds a token holder. */
const MAX_BODY_BYTES = 64 * 1024;

/**
 * The body is Claude's hook input forwarded unchanged, so Yarvis's own values
 * ride in the query string (the workspace baked into the hook, Claude's pid) and
 * in headers (the PTY's key and token).
 */
const querySchema = z.object({
  workspaceId: UUID,
  pid: z.coerce.number().int().positive().max(2_147_483_647),
});

/**
 * The PTY id charset the core generates. Session keys and ids are returned to
 * the chat model by `list_workspaces`, so they are held to plain identifiers
 * rather than free text.
 */
const sessionKeySchema = z
  .string()
  .min(1)
  .max(MAX_SESSION_KEY)
  .regex(/^[A-Za-z0-9:_./-]+$/);

/**
 * The fields used from Claude Code's hook input. Everything else in it
 * (transcript path, cwd, cost estimates on a resume) is dropped by the parse.
 */
const hookInputSchema = z.object({
  hook_event_name: z.enum(["SessionStart", "SessionEnd"]),
  session_id: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z0-9-]+$/),
  source: z.string().max(32).optional(),
  reason: z.string().max(32).optional(),
});

/**
 * Agent-session ingest, mounted at `/ingest/agent-session` outside the main
 * bearer wall like attention-ingest, and on the same scoped token: the hooks run
 * in the session's shell, which holds only that token. A request must also
 * carry its PTY's own session token, so all a caller can do is record that a
 * Claude session in its own terminal started or ended.
 */
export function createAgentSessionIngestRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.attentionToken }));
  router.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES }));

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.post("/", async (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.flatten() }, 400);
    const key = sessionKeySchema.safeParse(c.req.header(SESSION_KEY_HEADER));
    if (!key.success) return c.json({ error: `missing or malformed ${SESSION_KEY_HEADER}` }, 400);
    const sessionKey = key.data;
    if (
      !sessionTokenMatches(
        config.attentionToken,
        sessionKey,
        c.req.header(SESSION_TOKEN_HEADER) ?? "",
      )
    ) {
      return c.json({ error: "session token does not match the session key" }, 403);
    }
    const input = hookInputSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: input.error.flatten() }, 400);

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
