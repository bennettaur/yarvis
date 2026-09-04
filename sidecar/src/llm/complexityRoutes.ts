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

/**
 * Same shape `llm/routes.ts`'s `saveSchema` enforces on a model id: some
 * providers (Gemini) embed it directly in a request path, so `..` or an
 * unexpected shape is rejected here rather than at the first call that uses it.
 */
const SEGMENT = "[A-Za-z0-9][A-Za-z0-9._-]*";
const MODEL_ID = new RegExp(`^${SEGMENT}(/${SEGMENT})?(:${SEGMENT})?$`);

const modelId = z
  .string()
  .min(1)
  .max(128)
  .refine((v) => !v.includes(".."), "model id must not contain '..'")
  .refine((v) => MODEL_ID.test(v), "model id has an unexpected shape");

const providerId = z.string().min(1).max(128);

const selectionSchema = z.object({ provider: providerId, model: modelId }).nullable();

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
