import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import {
  DEFAULT_MODELS,
  deleteProviderModel,
  listProviderModels,
  MODEL_CAPABILITIES,
  resetProviderModels,
  saveProviderModel,
} from "./catalog.ts";

/**
 * The model catalogue, mounted under /api/model-catalog.
 *
 * Reads answer with both halves — the configured rows and the bundled defaults
 * they stand in for — because the settings UI has to show what a provider
 * currently offers *and* what it would fall back to if its rows were cleared.
 */

/**
 * Same shape `voice/speech.ts` enforces on a model id before it reaches a
 * request path, applied here so a bad id is rejected where it is typed rather
 * than at the first call that uses it.
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

const saveSchema = z.object({
  providerId,
  modelId,
  capabilities: z.array(z.enum(MODEL_CAPABILITIES)).min(1),
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(9999).optional(),
});

export function createModelCatalogRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/", async (c) =>
    c.json({
      capabilities: MODEL_CAPABILITIES,
      defaults: DEFAULT_MODELS,
      models: await listProviderModels(db()),
    }),
  );

  router.put("/", async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveProviderModel(db(), parsed.data));
  });

  /**
   * Identified by query rather than path segments: a Hub model id carries a
   * slash (`openai/whisper-large-v3`), which no amount of encoding makes safe
   * to read back out of a path.
   */
  router.delete("/model", async (c) => {
    const parsed = z
      .object({ providerId, modelId })
      .safeParse({ providerId: c.req.query("providerId"), modelId: c.req.query("modelId") });
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const ok = await deleteProviderModel(db(), parsed.data.providerId, parsed.data.modelId);
    if (!ok) return c.json({ error: "not found" }, 404);
    return c.body(null, 204);
  });

  /** Clears a provider's rows, which returns it to the bundled defaults. */
  router.delete("/provider/:providerId", async (c) => {
    const parsed = providerId.safeParse(c.req.param("providerId"));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json({ removed: await resetProviderModels(db(), parsed.data) });
  });

  return router;
}
