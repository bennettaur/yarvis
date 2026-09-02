import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  DEFAULT_COMPLEXITY_MODEL_CONFIG,
  getComplexityModelConfig,
  saveComplexityModelConfig,
} from "./complexity.ts";

/**
 * Complexity-tier model routes, mounted under /api/complexity-models.
 *
 * Mirrors `voice/routes.ts`'s `/config` pair: a null tier is meaningful ("fall
 * back to the default chat model"), so absent and cleared differ, and reads
 * answer the defaults with no database rather than 503.
 */

const selectionSchema = z
  .object({
    provider: z.string().min(1).max(128),
    model: z.string().min(1).max(128),
  })
  .nullable();

const saveSchema = z.object({
  low: selectionSchema.optional(),
  medium: selectionSchema.optional(),
  max: selectionSchema.optional(),
});

export function createComplexityModelRoutes(config: Config): Hono {
  const router = new Hono();

  const db = () => (config.databaseUrl ? getDb(config.databaseUrl).db : undefined);

  router.get("/", async (c) => {
    const database = db();
    if (!database) return c.json(DEFAULT_COMPLEXITY_MODEL_CONFIG);
    return c.json(await getComplexityModelConfig(database));
  });

  router.patch("/", async (c) => {
    const database = db();
    if (!database) return c.json({ error: "database not configured" }, 503);
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveComplexityModelConfig(database, parsed.data));
  });

  return router;
}
