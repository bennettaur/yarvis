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
 * so it takes a Claude Code model alias and a budget instead of a
 * provider/model pair. Kept under its own `prVerification` key.
 *
 * The budget is a warning threshold, not a cap: a run estimated over it asks
 * the user first, and once they agree it runs to the end whatever it costs.
 * `maxBudgetUsd` is not a maximum; it keeps that name because it is the
 * stored settings key.
 */
export const VERIFICATION_MODELS = ["sonnet", "opus", "haiku"] as const;

export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

/** `VERIFICATION_BUDGET_MIN_USD` in `src/lib/pr/models.ts` mirrors this. */
const VERIFICATION_BUDGET_MIN_USD = 0.25;

export const verificationRunConfigSchema = z.object({
  model: z.enum(VERIFICATION_MODELS),
  maxBudgetUsd: z.number().min(VERIFICATION_BUDGET_MIN_USD),
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

/**
 * The "What's changed" re-review summary also runs on Claude Code, under its
 * own `prRereview` key: it reads far less than a verification report, so it
 * gets its own, smaller budget. `autoStart` runs it when the "Since last
 * review" tab opens on a range it hasn't summarised, instead of waiting for
 * the button.
 */
export const rereviewRunConfigSchema = verificationRunConfigSchema.extend({
  autoStart: z.boolean(),
});

export type RereviewRunConfig = z.infer<typeof rereviewRunConfigSchema>;

export const DEFAULT_REREVIEW_RUN_CONFIG: RereviewRunConfig = {
  model: "sonnet",
  maxBudgetUsd: 1,
  autoStart: false,
};

const REREVIEW_SETTINGS_KEY = "prRereview";

function rereviewConfigFrom(stored: Record<string, unknown> | undefined): RereviewRunConfig {
  const shape = rereviewRunConfigSchema.shape;
  const model = shape.model.safeParse(stored?.model);
  const budget = shape.maxBudgetUsd.safeParse(stored?.maxBudgetUsd);
  const autoStart = shape.autoStart.safeParse(stored?.autoStart);
  return {
    model: model.success ? model.data : DEFAULT_REREVIEW_RUN_CONFIG.model,
    maxBudgetUsd: budget.success ? budget.data : DEFAULT_REREVIEW_RUN_CONFIG.maxBudgetUsd,
    autoStart: autoStart.success ? autoStart.data : DEFAULT_REREVIEW_RUN_CONFIG.autoStart,
  };
}

export async function getRereviewRunConfig(): Promise<RereviewRunConfig> {
  return rereviewConfigFrom(await readSection(REREVIEW_SETTINGS_KEY));
}

/** Merges the given fields onto the stored settings and writes them back. */
export async function saveRereviewRunConfig(
  input: Partial<RereviewRunConfig>,
): Promise<RereviewRunConfig> {
  return withSection<Record<string, unknown>, RereviewRunConfig>(
    REREVIEW_SETTINGS_KEY,
    (current) => {
      const next = { ...rereviewConfigFrom(current), ...input };
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
