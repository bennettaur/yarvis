import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { listSpecialists, resetSpecialist, updateSpecialist } from "./specialists.ts";

/**
 * Specialist routes, mounted under /api/specialists. A specialist is
 * configuration — prompt, model, tool subset — so this is a settings surface:
 * read the shipped set, retune one, put it back. Running one is not here on
 * purpose; the only caller that should start a run is the orchestrator's
 * `delegate` tool, which goes through `runSpecialist` directly.
 */

const patchSchema = z.object({
  description: z.string().min(1).max(1000).optional(),
  prompt: z.string().min(1).max(8000).optional(),
  toolIds: z.array(z.string().min(1).max(200)).max(64).optional(),
  unattendedToolIds: z.array(z.string().min(1).max(200)).max(16).optional(),
  provider: z.string().min(1).nullable().optional(),
  model: z.string().min(1).nullable().optional(),
  maxSteps: z.number().int().min(1).max(30).optional(),
  enabled: z.boolean().optional(),
});

export function createSpecialistRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) => c.json(await listSpecialists(db())));

  router.patch("/:id", async (c) => {
    const parsed = patchSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const updated = await updateSpecialist(db(), c.req.param("id"), parsed.data);
    if (!updated) return c.json({ error: "not found" }, 404);
    return c.json(updated);
  });

  // Puts a built-in back to its shipped prompt and tool set, for when an edit
  // went wrong — seeding only inserts, so without this an edit is permanent.
  router.post("/:name/reset", async (c) => {
    const reset = await resetSpecialist(db(), c.req.param("name"));
    if (!reset) return c.json({ error: "not a built-in specialist" }, 404);
    return c.json(reset);
  });

  return router;
}
