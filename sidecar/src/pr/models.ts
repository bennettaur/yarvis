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

/** The provider/model for a feature, or the default chat model when it is unset. */
export async function resolvePrModel(
  config: Config,
  feature: PrModelFeature,
): Promise<ModelSelection | null> {
  const stored = (await getPrModelConfig())[feature];
  return stored ?? (await defaultProviderModel(config));
}
