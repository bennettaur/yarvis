import { Hono } from "hono";
import { securityLog } from "./securityLog.ts";

/**
 * Telegram routes, mounted under /api/telegram. Currently only exposes the
 * security-event feed the desktop app polls to surface OS notifications for
 * unlock/failed/lockout activity. Authenticated by the same bearer token as the
 * rest of /api.
 */
export function createTelegramRoutes(): Hono {
  const router = new Hono();

  // Returns auth events whose sequence is greater than `since`. The client
  // passes the highest seq it has seen so it only notifies on genuinely new
  // activity; an absent/invalid `since` returns everything (seq 0 is before the
  // first event).
  router.get("/security-events", (c) => {
    const since = Number(c.req.query("since"));
    return c.json({ events: securityLog.since(Number.isFinite(since) ? since : 0) });
  });

  return router;
}
