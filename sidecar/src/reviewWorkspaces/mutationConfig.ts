import { Hono } from "hono";
import { z } from "zod";
import { readSection, withSection } from "../settings/store.ts";

/**
 * How a mutation-testing pass is sized: the Claude Code model and budget of
 * its planning run and of its explanation run, how many mutants it makes, and
 * the longest any one test command may run. Kept under the `mutationTesting`
 * key in `~/.yarvis/settings.json`, like the PR review models, and read at the
 * start of every pass so a change applies to the next.
 */

/** `MUTATION_LIMITS` in `src/lib/pr/mutationTestingConfig.ts` mirrors these limits. */
const MAX_MUTANTS_LIMIT = 30;

/**
 * A Claude Code `--model` value: an alias (`sonnet`, `opus`, `haiku`) or a full
 * model id. It becomes one argv entry, so nothing that could pass for a flag
 * or carry a control character.
 */
const modelSchema = z
  .string()
  .trim()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:[\]-]{0,99}$/, "not a model name");

const mutationTestingConfigSchema = z.object({
  /** Null runs Claude Code's own default model. */
  planningModel: modelSchema.nullable(),
  planningBudgetUsd: z.number().min(0.1).max(20),
  explanationModel: modelSchema.nullable(),
  explanationBudgetUsd: z.number().min(0.05).max(20),
  maxMutants: z.number().int().min(1).max(MAX_MUTANTS_LIMIT),
  /** A mutant's tests get three times the baseline's time, up to this. */
  testTimeoutCapSeconds: z.number().int().min(30).max(3_600),
});

export type MutationTestingConfig = z.infer<typeof mutationTestingConfigSchema>;

/**
 * Sonnet rather than Claude Code's default, which may be a pricier model than
 * reading a diff and writing up a few survivors needs. A budget is a ceiling: a
 * planning run that reaches it ends without a plan, and the pass with it.
 */
export const DEFAULT_MUTATION_TESTING_CONFIG: MutationTestingConfig = {
  planningModel: "sonnet",
  planningBudgetUsd: 1,
  explanationModel: "sonnet",
  explanationBudgetUsd: 0.5,
  maxMutants: 12,
  testTimeoutCapSeconds: 300,
};

const SETTINGS_KEY = "mutationTesting";

/**
 * Each stored field that is valid, over the defaults. The file is
 * hand-editable, and a bad value in one field shouldn't reset the others.
 */
function parseStoredConfig(stored: unknown): MutationTestingConfig {
  const out: MutationTestingConfig = { ...DEFAULT_MUTATION_TESTING_CONFIG };
  if (!stored || typeof stored !== "object") return out;
  const record = stored as Record<string, unknown>;
  for (const [key, schema] of Object.entries(mutationTestingConfigSchema.shape)) {
    const parsed = schema.safeParse(record[key]);
    if (parsed.success) (out as Record<string, unknown>)[key] = parsed.data;
  }
  return out;
}

export async function getMutationTestingConfig(): Promise<MutationTestingConfig> {
  return parseStoredConfig(await readSection<unknown>(SETTINGS_KEY));
}

/** Merges the given fields onto the stored config and writes the result back. */
async function saveMutationTestingConfig(
  input: Partial<MutationTestingConfig>,
): Promise<MutationTestingConfig> {
  return withSection<unknown, MutationTestingConfig>(SETTINGS_KEY, (current) => {
    const next = { ...parseStoredConfig(current), ...input };
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
