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
import { type ChannelHub, channelHub, type RelayIdentity } from "./hub.ts";

/** Longest reply a session can post; the agent reads it back into a prompt. */
export const MAX_REPLY_CHARS = 8_000;

export const RELAY_ID_HEADER = "X-Yarvis-Relay-Id";
export const RELAY_PID_HEADER = "X-Yarvis-Relay-Pid";
export const CHANNEL_ENABLED_HEADER = "X-Yarvis-Channel-Enabled";

const relaySchema = z.object({
  relayId: z.string().uuid(),
  pid: z.coerce.number().int().positive().max(2_147_483_647),
  channelEnabled: z.enum(["0", "1"]).transform((v) => v === "1"),
});

const replySchema = z.object({
  messageId: z.string().uuid(),
  text: z.string().min(1).max(MAX_REPLY_CHARS),
});

/**
 * The relay's side of the channel, mounted at `/ingest/channel` outside the
 * main bearer wall. Like the agent-session hooks, a request needs the scoped
 * ingest token and its PTY's own session token, so a relay can only read the
 * messages meant for the terminal it runs in and answer as that terminal.
 */
export function createChannelRoutes(config: Config, hub: ChannelHub = channelHub) {
  const router = new Hono<{ Variables: { sessionKey: string; relay: RelayIdentity } }>();

  router.use("*", bearerAuth({ token: config.attentionToken }));
  // Room for a maximum-length reply in UTF-8 (up to 4 bytes a character).
  router.use("*", bodyLimit({ maxSize: MAX_REPLY_CHARS * 4 }));
  router.use("*", async (c, next) => {
    const key = sessionKeySchema.safeParse(c.req.header(SESSION_KEY_HEADER));
    if (!key.success) return c.json({ error: `missing or malformed ${SESSION_KEY_HEADER}` }, 400);
    if (!sessionTokenMatches(config.token, key.data, c.req.header(SESSION_TOKEN_HEADER) ?? "")) {
      return c.json({ error: "session token does not match the session key" }, 403);
    }
    const relay = relaySchema.safeParse({
      relayId: c.req.header(RELAY_ID_HEADER),
      pid: c.req.header(RELAY_PID_HEADER),
      channelEnabled: c.req.header(CHANNEL_ENABLED_HEADER),
    });
    if (!relay.success) return c.json({ error: "missing or malformed relay headers" }, 400);
    c.set("sessionKey", key.data);
    c.set("relay", relay.data);
    return next();
  });

  router.get("/next", async (c) => {
    const poll = hub.next(c.get("sessionKey"), c.get("relay"), c.req.raw.signal);
    if (!poll) return c.json({ error: "another relay owns this terminal's channel" }, 409);
    return c.json({ messages: await poll });
  });

  router.post("/reply", async (c) => {
    const body = replySchema.safeParse(await c.req.json().catch(() => null));
    if (!body.success) return c.json({ error: body.error.flatten() }, 400);
    const recorded = hub.recordReply(
      c.get("sessionKey"),
      c.get("relay").relayId,
      body.data.messageId,
      body.data.text,
    );
    if (!recorded) {
      return c.json({ error: "no message with that id was sent to this session" }, 404);
    }
    return c.body(null, 204);
  });

  return router;
}
