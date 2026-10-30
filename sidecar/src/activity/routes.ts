import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { MAX_SESSION_KEY, UUID } from "../attention/routes.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { workspaces } from "../db/schema.ts";
import {
  SESSION_KEY_HEADER,
  SESSION_TOKEN_HEADER,
  sessionKeyBelongsTo,
  sessionTokenMatches,
} from "../workspaces/agentSessions.ts";
import { claudeHookSchema, fromClaudeHook } from "./classify.ts";
import {
  type ActivityEvent,
  hasActivitySubscribers,
  publishActivity,
  subscribeActivity,
} from "./hub.ts";

/**
 * A PreToolUse body carries the tool's whole input, so a Write of a big file is
 * big. Only a few fields are read; a body past this is refused and that one
 * event is skipped.
 */
const MAX_BODY_BYTES = 1024 * 1024;

/** Cap on a single stream's pending-write queue, so a stalled reader is bounded. */
const MAX_STREAM_QUEUE = 512;

/** Heartbeat interval so an idle stream isn't dropped. */
const HEARTBEAT_MS = 15_000;

/** How long a workspace's name is reused before it is looked up again, so a rename shows up. */
const NAME_TTL_MS = 60_000;

const querySchema = z.object({ workspaceId: UUID });

/**
 * Activity ingest, mounted at `/ingest/activity` outside the main bearer wall
 * like the other session hooks, on the same scoped token plus the PTY's own
 * session token. All a caller can do is put an event for its own workspace on
 * the Agent Field page.
 */
export function createActivityIngestRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.attentionToken }));
  router.use("*", bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.body(null, 413) }));

  // A busy session posts several events a second, and the name only labels a node.
  const names = new Map<string, { name: string; at: number }>();
  const workspaceName = async (workspaceId: string): Promise<string | undefined> => {
    const cached = names.get(workspaceId);
    if (cached && Date.now() - cached.at < NAME_TTL_MS) return cached.name;
    if (!config.databaseUrl) return undefined;
    // A failed lookup isn't cached, and must not drop the event: it falls back to a generic name.
    const [ws] = await getDb(config.databaseUrl)
      .db.select({ name: workspaces.name })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .catch(() => []);
    if (ws) names.set(workspaceId, { name: ws.name, at: Date.now() });
    return ws?.name;
  };

  router.post("/", async (c) => {
    const query = querySchema.safeParse(c.req.query());
    if (!query.success) return c.json({ error: query.error.flatten() }, 400);
    const sessionKey = c.req.header(SESSION_KEY_HEADER) ?? "";
    if (!sessionKey || sessionKey.length > MAX_SESSION_KEY) {
      return c.json({ error: `missing or malformed ${SESSION_KEY_HEADER}` }, 400);
    }
    if (!sessionTokenMatches(config.token, sessionKey, c.req.header(SESSION_TOKEN_HEADER) ?? "")) {
      return c.json({ error: "session token does not match the session key" }, 403);
    }
    const { workspaceId } = query.data;
    if (!sessionKeyBelongsTo(sessionKey, workspaceId)) {
      return c.json({ error: "session key does not belong to that workspace" }, 400);
    }
    // Nobody is watching, so skip the parse and the lookup.
    if (!hasActivitySubscribers()) return c.body(null, 204);

    const hook = claudeHookSchema.safeParse(await c.req.json().catch(() => null));
    if (!hook.success) return c.json({ error: hook.error.flatten() }, 400);

    const event = fromClaudeHook(hook.data, (await workspaceName(workspaceId)) ?? "claude");
    if (event) publishActivity(event);
    return c.body(null, 204);
  });

  return router;
}

/** The live activity stream, mounted at `/api/activity` behind the main bearer. */
export function createActivityRoutes(): Hono {
  const router = new Hono();

  // Purely forward: the page draws only what is happening now.
  router.get("/stream", (c) =>
    streamSSE(c, async (stream) => {
      const queue: ActivityEvent[] = [];
      let wake: (() => void) | null = null;
      const unsubscribe = subscribeActivity((event) => {
        queue.push(event);
        if (queue.length > MAX_STREAM_QUEUE) queue.shift();
        wake?.();
      });

      const signal = c.req.raw.signal;

      // Resolves when an event is queued, the heartbeat is due or the client
      // goes away, removing its own timer and listener either way.
      const waitForEvent = () =>
        new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", finish);
            wake = null;
            resolve();
          };
          const timer = setTimeout(finish, HEARTBEAT_MS);
          signal.addEventListener("abort", finish, { once: true });
          wake = finish;
        });

      const ping = () => stream.writeSSE({ data: JSON.stringify({ type: "ping" }) });

      try {
        // The client counts the stream as live from its first frame, so send one now.
        await ping();
        while (!signal.aborted) {
          while (queue.length > 0) {
            await stream.writeSSE({
              data: JSON.stringify({ type: "event", event: queue.shift() }),
            });
          }
          await waitForEvent();
          if (queue.length === 0 && !signal.aborted) await ping();
        }
      } finally {
        unsubscribe();
      }
    }),
  );

  return router;
}
