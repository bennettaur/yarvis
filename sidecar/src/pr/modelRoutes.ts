import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { selectionSchema } from "../llm/complexityRoutes.ts";
import {
  getPrModelConfig,
  getRereviewRunConfig,
  getVerificationRunConfig,
  rereviewRunConfigSchema,
  savePrModelConfig,
  saveRereviewRunConfig,
  saveVerificationRunConfig,
  verificationRunConfigSchema,
} from "./models.ts";

/**
 * PR review model routes, mounted under /api/pr-models. Kept apart from
 * `/api/pr` because that router refuses every request without a database, and
 * this setting lives in settings.json.
 */

const saveSchema = z.object({
  guide: selectionSchema.optional(),
  ask: selectionSchema.optional(),
});

export function createPrModelRoutes(_config: Config): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await getPrModelConfig()));

  router.patch("/", async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await savePrModelConfig(parsed.data));
  });

  // The verification report's Claude Code model and budget.
  router.get("/verification", async (c) => c.json(await getVerificationRunConfig()));

  router.patch("/verification", async (c) => {
    const parsed = verificationRunConfigSchema
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveVerificationRunConfig(parsed.data));
  });

  // The "What's changed" summary's model, budget and auto-start.
  router.get("/rereview", async (c) => c.json(await getRereviewRunConfig()));

  router.patch("/rereview", async (c) => {
    const parsed = rereviewRunConfigSchema
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveRereviewRunConfig(parsed.data));
  });

  return router;
}
