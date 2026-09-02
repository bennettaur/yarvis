import { Hono } from "hono";
import { z } from "zod";
import { knownScopes, recentLogs } from "../lib/log.ts";

const querySchema = z.object({
  minLevel: z.enum(["debug", "info", "warn", "error"]).optional(),
  scope: z.string().max(32).optional(),
  contains: z.string().max(200).optional(),
  after: z.coerce.number().int().nonnegative().optional(),
  limit: z.coerce.number().int().min(1).max(2000).optional(),
});

/**
 * The sidecar's own log tail, mounted under /api/logs. The Diagnostics view
 * reads it so a failure can be inspected from inside the app — a packaged
 * build's stdout is not somewhere the user can look.
 */
export function createLogRoutes(): Hono {
  const router = new Hono();

  router.get("/", (c) => {
    const parsed = querySchema.safeParse(c.req.query());
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { minLevel, scope, contains, after, limit } = parsed.data;
    return c.json({
      entries: recentLogs({ minLevel, scope, contains, after, limit }),
      scopes: knownScopes(),
    });
  });

  return router;
}
