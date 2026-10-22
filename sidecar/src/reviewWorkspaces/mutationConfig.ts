import { Hono } from "hono";
import { z } from "zod";
import { readSection, withSection } from "../settings/store.ts";

/**
 * How a mutation-testing run is sized: which Claude Code model runs it, the
 * most it may spend, and how many mutants it makes. Kept under the
 * `mutationTesting` key in `~/.yarvis/settings.json`, like the PR review
 * models, and read at the start of every run so a change applies to the next.
 */

export const MAX_MUTANTS_LIMIT = 30;

/**
 * A Claude Code `--model` value: an alias (`sonnet`, `opus`, `haiku`) or a full
 * model id. It becomes one argv entry, so nothing that could pass for a flag
 * or carry a control character.
 */
const modelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, "not a model name");

export const mutationTestingConfigSchema = z.object({
  /** Null runs Claude Code's own default model. */
  model: modelSchema.nullable(),
  maxBudgetUsd: z.number().min(0.1).max(50),
  maxMutants: z.number().int().min(1).max(MAX_MUTANTS_LIMIT),
});

export type MutationTestingConfig = z.infer<typeof mutationTestingConfigSchema>;

/**
 * Sonnet rather than Claude Code's default, which may be a pricier model than a
 * dozen edit-and-test loops need. About $2 covers a dozen mutants on a small
 * suite; the cap is a ceiling, and a run that reaches it ends without a report.
 */
export const DEFAULT_MUTATION_TESTING_CONFIG: MutationTestingConfig = {
  model: "sonnet",
  maxBudgetUsd: 2,
  maxMutants: 12,
};

const SETTINGS_KEY = "mutationTesting";

/**
 * Each stored field that is valid, over the defaults. The file is
 * hand-editable, and a bad value in one field shouldn't reset the others.
 */
function merged(stored: unknown): MutationTestingConfig {
  const out: MutationTestingConfig = { ...DEFAULT_MUTATION_TESTING_CONFIG };
  if (!stored || typeof stored !== "object") return out;
  const record = stored as Record<string, unknown>;
  const shape = mutationTestingConfigSchema.shape;
  const model = shape.model.safeParse(record.model);
  if ("model" in record && model.success) out.model = model.data;
  const budget = shape.maxBudgetUsd.safeParse(record.maxBudgetUsd);
  if (budget.success) out.maxBudgetUsd = budget.data;
  const mutants = shape.maxMutants.safeParse(record.maxMutants);
  if (mutants.success) out.maxMutants = mutants.data;
  return out;
}

export async function getMutationTestingConfig(): Promise<MutationTestingConfig> {
  return merged(await readSection<unknown>(SETTINGS_KEY));
}

/** Merges the given fields onto the stored config and writes the result back. */
export async function saveMutationTestingConfig(
  input: Partial<MutationTestingConfig>,
): Promise<MutationTestingConfig> {
  return withSection<unknown, MutationTestingConfig>(SETTINGS_KEY, (current) => {
    const next = { ...merged(current), ...input };
    return { next, result: next };
  });
}

/**
 * Mounted under /api/mutation-testing-config. Apart from the review-workspace
 * routes because those refuse every request without a database, and this
 * lives in settings.json.
 */
export function createMutationTestingConfigRoutes(): Hono {
  const router = new Hono();

  router.get("/", async (c) => c.json(await getMutationTestingConfig()));

  router.patch("/", async (c) => {
    const parsed = mutationTestingConfigSchema
      .partial()
      .strict()
      .safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await saveMutationTestingConfig(parsed.data));
  });

  return router;
}
