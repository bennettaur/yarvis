import type { Config } from "../config.ts";
import { readSection, withSection } from "../settings/store.ts";
import { defaultProviderModel, type ProviderId } from "./providers.ts";

/**
 * Singleton store for which model backs each complexity tier of internal-use
 * LLM calls, kept as one plain object under the `complexityModels` key in
 * `~/.yarvis/settings.json` — the same way `voiceConfig` is.
 */

export const COMPLEXITY_TIERS = ["low", "medium", "max"] as const;

export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];

export function isComplexityTier(value: string): value is ComplexityTier {
  return (COMPLEXITY_TIERS as readonly string[]).includes(value);
}

export interface ModelSelection {
  provider: ProviderId;
  model: string;
}

export interface ComplexityModelConfigInput {
  low: ModelSelection | null;
  medium: ModelSelection | null;
  max: ModelSelection | null;
}

/** What every surface sees before any tier is configured. */
export const DEFAULT_COMPLEXITY_MODEL_CONFIG: ComplexityModelConfigInput = {
  low: null,
  medium: null,
  max: null,
};

const SETTINGS_KEY = "complexityModels";

/** Returns the stored tier config, merged onto all-unset for whatever hasn't been saved. */
export async function getComplexityModelConfig(): Promise<ComplexityModelConfigInput> {
  const stored = await readSection<Partial<ComplexityModelConfigInput>>(SETTINGS_KEY);
  return { ...DEFAULT_COMPLEXITY_MODEL_CONFIG, ...stored };
}

/**
 * Merges the given tiers onto the existing stored config and writes the whole
 * result back. Every field is optional so the settings UI can save one tier at
 * a time; a tier explicitly set to `null` clears it back to "unset".
 */
export async function saveComplexityModelConfig(
  input: Partial<ComplexityModelConfigInput>,
): Promise<ComplexityModelConfigInput> {
  return withSection<Partial<ComplexityModelConfigInput>, ComplexityModelConfigInput>(
    SETTINGS_KEY,
    (current) => {
      const next = { ...DEFAULT_COMPLEXITY_MODEL_CONFIG, ...current, ...input };
      return { next, result: next };
    },
  );
}

/**
 * Resolves the provider/model for a tier, falling back to the general default
 * chat model when that tier is unset — the same fallback a specialist with no
 * `model:` of its own uses today, so configuring nothing changes nothing.
 */
export async function resolveComplexityModel(
  config: Config,
  tier: ComplexityTier,
): Promise<ModelSelection | null> {
  const stored = (await getComplexityModelConfig())[tier];
  return stored ?? (await defaultProviderModel(config));
}
