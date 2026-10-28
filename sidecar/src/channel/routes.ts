import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { bodyLimit } from "hono/body-limit";
import { z } from "zod";
import type { Config } from "../config.ts";
import { sessionKeySchema } from "../workspaces/agentSessionIngest.ts";
import {
  SESSION_KEY_HEADER,
  SESSION_TOKEN_HEADER,
  sessionTokenMatches,
} from "../workspaces/agentSessions.ts";
import { type ChannelHub, channelHub } from "./hub.ts";

/** Longest reply a session can post; the agent reads it back into a prompt. */
export const MAX_REPLY_CHARS = 8_000;

const replySchema = z.object({
  messageId: z.string().uuid().nullable().optional(),
  text: z.string().min(1).max(MAX_REPLY_CHARS),
});

/**
 * The relay's side of the channel, mounted at `/ingest/channel` outside the
 * main bearer wall. Like the agent-session hooks, a request needs the scoped
 * ingest token and its PTY's own session token, so a relay can only read the
 * messages meant for the terminal it runs in and answer as that terminal.
 */
export function createChannelRoutes(config: Config, hub: ChannelHub = channelHub) {
  const router = new Hono<{ Variables: { sessionKey: string } }>();

  router.use("*", bearerAuth({ token: config.attentionToken }));
  router.use("*", bodyLimit({ maxSize: MAX_REPLY_CHARS * 4 }));
  router.use("*", async (c, next) => {
    const key = sessionKeySchema.safeParse(c.req.header(SESSION_KEY_HEADER));
    if (!key.success) return c.json({ error: `missing or malformed ${SESSION_KEY_HEADER}` }, 400);
    if (!sessionTokenMatches(config.token, key.data, c.req.header(SESSION_TOKEN_HEADER) ?? "")) {
      return c.json({ error: "session token does not match the session key" }, 403);
    }
    c.set("sessionKey", key.data);
    return next();
  });

  router.get("/next", async (c) => {
    const messages = await hub.next(c.get("sessionKey"), c.req.raw.signal);
    return c.json({ messages });
  });

  router.post("/reply", async (c) => {
    const body = replySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    hub.reply(c.get("sessionKey"), {
      messageId: body.data.messageId ?? null,
      text: body.data.text,
    });
    return c.body(null, 204);
  });

  return router;
}
