import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import { z } from "zod";
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
  error: z.string().max(1000).optional(),
});

export function createBrowserRoutes(bridge: BrowserBridge = browserBridge): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: bridge.token }));

  // Long poll: answers with the next command, or 204 once the hold expires.
  router.get("/next", async (c) => {
    const next = await bridge.next(undefined, c.req.raw.signal);
    return next ? c.json(next) : c.body(null, 204);
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
