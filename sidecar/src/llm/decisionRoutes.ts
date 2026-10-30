import { Hono } from "hono";
import { z } from "zod";
import { selectionSchema } from "./complexityRoutes.ts";
import { getDecisionModelConfig, saveDecisionModelConfig } from "./decision.ts";

/**
 * Decision-model routes, mounted under /api/decision-model. Read directly from
 * settings.json, like the complexity tiers — no database involved.
 */

const saveSchema = z.object({
  model: selectionSchema.optional(),
  autoApproveTools: z.boolean().optional(),
  autoApproveHeadsDown: z.boolean().optional(),
  routeComplexity: z.boolean().optional(),
});

export function createDecisionModelRoutes(): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await getDecisionModelConfig()));

  router.patch("/", async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveDecisionModelConfig(parsed.data));
  });

  return router;
}
