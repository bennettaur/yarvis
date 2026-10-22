import { z } from "zod";
import type { Config } from "../config.ts";
import type { ModelSelection } from "../llm/complexity.ts";
import { defaultProviderModel } from "../llm/providers.ts";
import { readSection, withSection } from "../settings/store.ts";

/**
 * Which model backs each PR review feature, kept as one plain object under the
 * `prModels` key in `~/.yarvis/settings.json` — the same way `complexityModels`
 * is.
 */

export const PR_MODEL_FEATURES = ["guide", "ask"] as const;

/** `guide` writes the guided review (the tour); `ask` answers line questions. */
export type PrModelFeature = (typeof PR_MODEL_FEATURES)[number];

export type PrModelConfig = Record<PrModelFeature, ModelSelection | null>;

/** What every surface sees before any feature is configured. */
export const DEFAULT_PR_MODEL_CONFIG: PrModelConfig = {
  guide: null,
  ask: null,
};

const SETTINGS_KEY = "prModels";

/** Returns the stored config, merged onto all-unset for whatever hasn't been saved. */
export async function getPrModelConfig(): Promise<PrModelConfig> {
  const stored = await readSection<Partial<PrModelConfig>>(SETTINGS_KEY);
  return { ...DEFAULT_PR_MODEL_CONFIG, ...stored };
}

/**
 * Merges the given features onto the stored config and writes the whole result
 * back, so the settings UI can save one feature at a time. A feature set to
 * `null` goes back to the default chat model.
 */
export async function savePrModelConfig(input: Partial<PrModelConfig>): Promise<PrModelConfig> {
  return withSection<Partial<PrModelConfig>, PrModelConfig>(SETTINGS_KEY, (current) => {
    const next = { ...DEFAULT_PR_MODEL_CONFIG, ...current, ...input };
    return { next, result: next };
  });
}

/**
 * The verification report runs on Claude Code rather than on a chat provider,
 * so it takes a Claude Code model alias and a spend ceiling instead of a
 * provider/model pair. Kept under its own `prVerification` key.
 */
export const VERIFICATION_MODELS = ["sonnet", "opus", "haiku"] as const;

export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

export const VERIFICATION_BUDGET_LIMITS = { min: 0.25, max: 20 } as const;

export const verificationRunConfigSchema = z.object({
  model: z.enum(VERIFICATION_MODELS),
  maxBudgetUsd: z.number().min(VERIFICATION_BUDGET_LIMITS.min).max(VERIFICATION_BUDGET_LIMITS.max),
});

export type VerificationRunConfig = z.infer<typeof verificationRunConfigSchema>;

export const DEFAULT_VERIFICATION_RUN_CONFIG: VerificationRunConfig = {
  model: "sonnet",
  maxBudgetUsd: 2,
};

const VERIFICATION_SETTINGS_KEY = "prVerification";

/**
 * The stored verification settings over the defaults. A stored field that no
 * longer validates (a hand edit, an alias since dropped) falls back to its
 * default rather than failing every run.
 */
function verificationConfigFrom(
  stored: Record<string, unknown> | undefined,
): VerificationRunConfig {
  const shape = verificationRunConfigSchema.shape;
  const model = shape.model.safeParse(stored?.model);
  const budget = shape.maxBudgetUsd.safeParse(stored?.maxBudgetUsd);
  return {
    model: model.success ? model.data : DEFAULT_VERIFICATION_RUN_CONFIG.model,
    maxBudgetUsd: budget.success ? budget.data : DEFAULT_VERIFICATION_RUN_CONFIG.maxBudgetUsd,
  };
}

export async function getVerificationRunConfig(): Promise<VerificationRunConfig> {
  return verificationConfigFrom(await readSection(VERIFICATION_SETTINGS_KEY));
}

/** Merges the given fields onto the stored settings and writes them back. */
export async function saveVerificationRunConfig(
  input: Partial<VerificationRunConfig>,
): Promise<VerificationRunConfig> {
  return withSection<Record<string, unknown>, VerificationRunConfig>(
    VERIFICATION_SETTINGS_KEY,
    (current) => {
      const next = { ...verificationConfigFrom(current), ...input };
      return { next, result: next };
    },
  );
}

/** The provider/model for a feature, or the default chat model when it is unset. */
export async function resolvePrModel(
  config: Config,
  feature: PrModelFeature,
): Promise<ModelSelection | null> {
  const stored = (await getPrModelConfig())[feature];
  return stored ?? (await defaultProviderModel(config));
}
