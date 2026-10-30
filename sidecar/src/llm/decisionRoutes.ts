import { Hono } from "hono";
import { z } from "zod";
import { CHOICE_PATTERN, findSpecialist } from "../agents/catalog.ts";
import {
  askDecision,
  type DecisionOption,
  MAX_OPTIONS,
  specialistOptions,
} from "../agents/decide.ts";
import type { Config } from "../config.ts";
import { selectionSchema } from "./complexityRoutes.ts";
import {
  getDecisionModelConfig,
  resolveDecisionModel,
  saveDecisionModelConfig,
} from "./decision.ts";
import { describeError, redactSecrets } from "./errors.ts";

/**
 * Decision-model routes, mounted under /api/decision-model. Read directly from
 * settings.json, like the complexity tiers — no database involved.
 */

const saveSchema = z.object({
  model: selectionSchema.optional(),
  autoApproveTools: z.boolean().optional(),
  autoApproveHeadsDown: z.boolean().optional(),
  routeComplexity: z.boolean().optional(),
  pickSpecialists: z.boolean().optional(),
});

/**
 * A playground run: a decision specialist by name, or instructions written on
 * the spot, asked about `input`. Options are required with instructions and
 * replace a specialist's own `choices` when given.
 */
const trySchema = z
  .object({
    specialist: z.string().min(1).max(64).optional(),
    instructions: z.string().trim().min(1).max(4_000).optional(),
    input: z.string().min(1).max(6_000),
    options: z
      .array(
        z.object({
          value: z.string().regex(CHOICE_PATTERN),
          description: z.string().max(300).optional(),
        }),
      )
      .min(2)
      .max(MAX_OPTIONS)
      .optional(),
  })
  .refine((body) => (body.specialist === undefined) !== (body.instructions === undefined), {
    message: "give either a specialist or instructions",
  })
  .refine((body) => body.specialist !== undefined || body.options !== undefined, {
    message: "instructions need options to pick from",
  });

export function createDecisionModelRoutes(config: Config): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await getDecisionModelConfig()));

  router.patch("/", async (c) => {
    const parsed = saveSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveDecisionModelConfig(parsed.data));
  });

  // The playground, for trying a decision before a feature relies on it. It
  // runs whether or not that feature is switched on, but only on the saved
  // decision model, so what it shows is what the feature would get.
  router.post("/try", async (c) => {
    const parsed = trySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    const selection = await resolveDecisionModel(config, (await getDecisionModelConfig()).model);
    if (!selection) return c.json({ error: "no usable decision model is selected" }, 409);

    let instructions: string;
    let options: DecisionOption[];
    if (body.specialist === undefined) {
      instructions = body.instructions ?? "";
      options = body.options ?? [];
    } else {
      const specialist = await findSpecialist(body.specialist);
      if (specialist?.kind !== "decision") {
        return c.json({ error: `no decision specialist named "${body.specialist}"` }, 404);
      }
      instructions = specialist.prompt;
      options = specialistOptions(specialist, body.options);
    }

    const started = Date.now();
    try {
      const answer = await askDecision(config, selection, {
        instructions,
        input: body.input,
        options,
        signal: c.req.raw.signal,
      });
      return c.json({ ...answer, model: selection, elapsedMs: Date.now() - started });
    } catch (e) {
      return c.json(
        { error: redactSecrets(describeError(e)), elapsedMs: Date.now() - started },
        502,
      );
    }
  });

  return router;
}
