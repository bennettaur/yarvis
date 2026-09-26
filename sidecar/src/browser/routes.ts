import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
import type { Config } from "../config.ts";
import { type BrowserBridge, browserBridge } from "./bridge.ts";

/**
 * The browser bridge's endpoints, mounted at `/browser` OUTSIDE the main bearer
 * wall. Like attention-ingest, they authenticate with their own scoped token, so
 * the extension's host reaches these two routes without holding the full-access
 * bearer.
 */

/** A page's text is capped by the tool asking for it; this bounds a misbehaving sender. */
const MAX_RESULT_BYTES = 2_000_000;

const resultSchema = z.object({
  id: z.string().min(1).max(64),
  ok: z.boolean(),
  data: z.unknown().optional(),
  // Cut rather than rejected: a 400 here would leave the tool waiting out its timeout.
  error: z
    .string()
    .transform((message) => message.slice(0, 1000))
    .optional(),
});

export function createBrowserRoutes(
  config: Pick<Config, "port">,
  bridge: BrowserBridge = browserBridge,
): Hono {
  const router = new Hono();

  // A page can resolve a name it controls to 127.0.0.1 and reach a loopback
  // port, so the Host must be one of ours — the same pin the MCP endpoint applies.
  router.use("*", async (c, next) => {
    const host = c.req.header("host");
    if (host !== `127.0.0.1:${config.port}` && host !== `localhost:${config.port}`) {
      return c.json({ error: "unexpected host" }, 403);
    }
    return next();
  });

  router.use("*", bearerAuth({ token: bridge.token }));

  // Long poll: answers with the next command, or 204 once the hold expires.
  router.get("/next", async (c) => {
    const signal = c.req.raw.signal;
    const next = await bridge.next(undefined, signal);
    if (next === "superseded") return c.json({ error: "another host is polling" }, 409);
    if (!next) return c.body(null, 204);
    // The client can vanish between the command being handed over and the answer
    // being written; give the command back rather than lose it.
    if (signal.aborted) bridge.requeue(next);
    return c.json(next);
  });

  router.post("/result", async (c) => {
    const declared = Number(c.req.header("content-length") ?? 0);
    if (declared > MAX_RESULT_BYTES) return c.json({ error: "result too large" }, 413);
    const text = await c.req.text();
    if (text.length > MAX_RESULT_BYTES) return c.json({ error: "result too large" }, 413);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return c.json({ error: "invalid JSON" }, 400);
    }
    const parsed = resultSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: "invalid result" }, 400);

    const { id, ...result } = parsed.data;
    // A late answer, after the tool gave up, is not the sender's mistake.
    return c.json({ delivered: bridge.complete(id, result) });
  });

  return router;
}
