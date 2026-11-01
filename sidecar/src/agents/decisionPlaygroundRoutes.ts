import { Hono } from "hono";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDecisionModelConfig, resolveDecisionModel } from "../llm/decision.ts";
import { describeError, redactSecrets } from "../llm/errors.ts";
import { findSpecialist } from "./catalog.ts";
import { askDecision, optionsProblem, specialistOptions } from "./decide.ts";
import {
  CHOICE_PATTERN,
  MAX_INPUT_CHARS,
  MAX_INSTRUCTIONS_CHARS,
  MAX_OPTION_DESCRIPTION_CHARS,
  MAX_OPTIONS,
} from "./decisionLimits.ts";

/**
 * The decision playground, mounted under /api/decision-playground: asks the
 * saved decision model one question, to see how it answers before a feature
 * relies on it. It runs whether or not that feature is switched on, but only
 * on the saved decision model, so what it shows is what the feature would get.
 */

const optionsSchema = z
  .array(
    z.object({
      value: z.string().regex(CHOICE_PATTERN),
      description: z.string().max(MAX_OPTION_DESCRIPTION_CHARS).optional(),
    }),
  )
  .min(2)
  .max(MAX_OPTIONS);

const inputSchema = z.string().min(1).max(MAX_INPUT_CHARS);

/**
 * A decision specialist by name, whose own `choices` apply unless options are
 * given, or instructions written on the spot, which need options.
 */
const trySchema = z.union([
  z.strictObject({
    specialist: z.string().min(1).max(64),
    input: inputSchema,
    options: optionsSchema.optional(),
  }),
  z.strictObject({
    instructions: z.string().trim().min(1).max(MAX_INSTRUCTIONS_CHARS),
    input: inputSchema,
    options: optionsSchema,
  }),
]);

/** @param fetchImpl Injected by tests in place of the network. */
export function createDecisionPlaygroundRoutes(config: Config, fetchImpl?: typeof fetch): Hono {
  const router = new Hono();

  router.post("/", async (c) => {
    const parsed = trySchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const body = parsed.data;

    const selection = await resolveDecisionModel(config, (await getDecisionModelConfig()).model);
    if (!selection) return c.json({ error: "no usable decision model is selected" }, 409);

    let instructions: string;
    let options: { value: string; description?: string }[];
    if ("specialist" in body) {
      const specialist = await findSpecialist(body.specialist);
      if (specialist?.kind !== "decision") {
        return c.json({ error: `no decision specialist named "${body.specialist}"` }, 404);
      }
      instructions = specialist.prompt;
      options = specialistOptions(specialist, body.options);
    } else {
      instructions = body.instructions;
      options = body.options;
    }
    // A specialist with no `choices` asked without options, or options listed twice.
    const problem = optionsProblem(options);
    if (problem) return c.json({ error: problem }, 400);

    const started = Date.now();
    try {
      const answer = await askDecision(config, selection, {
        instructions,
        input: body.input,
        options,
        signal: c.req.raw.signal,
        fetchImpl,
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
