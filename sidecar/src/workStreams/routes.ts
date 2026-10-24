import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { getStream, listStreams, updateStream } from "./service.ts";

/**
 * Matched by shape rather than with zod's `.uuid()`, which additionally enforces
 * RFC version/variant bits that Postgres itself does not — the same check
 * `todos/routes.ts` applies.
 */
const UUID = /^[0-9a-fA-F]{8}(-[0-9a-fA-F]{4}){3}-[0-9a-fA-F]{12}$/;

const status = z.enum(["active", "waiting-on-user", "waiting-on-others", "done", "dropped"]);

const patchSchema = z.object({
  status: status.optional(),
  priority: z.enum(["urgent", "high", "medium", "low"]).optional(),
  paused: z.boolean().optional(),
});

/**
 * Routes for work streams, mounted under /api/work-streams. The UI reads them
 * to show what heads-down mode is pushing forward, and the user can reprioritize,
 * pause or close a stream. Everything else, notes included, is written by the agent
 * through its tools, so a note is always the agent's own.
 */
export function createWorkStreamRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => {
    const statuses: z.infer<typeof status>[] = [];
    for (const raw of c.req.queries("status") ?? []) {
      const parsed = status.safeParse(raw);
      if (!parsed.success) return c.json({ error: `unknown status: ${raw}` }, 400);
      statuses.push(parsed.data);
    }
    return c.json(await listStreams(db(), { statuses: statuses.length ? statuses : undefined }));
  });

  router.get("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const stream = await getStream(db(), id);
    if (!stream) return c.json({ error: "not found" }, 404);
    return c.json(stream);
  });

  router.patch("/:id", async (c) => {
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "not found" }, 404);
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const stream = await updateStream(db(), id, parsed.data);
    if (!stream) return c.json({ error: "not found" }, 404);
    return c.json(stream);
  });

  return router;
}
