import { desc, eq } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type ComplexityModelConfigRow, complexityModelConfig } from "../db/schema.ts";
import { defaultProviderModel, type ProviderId } from "./providers.ts";

/**
 * Singleton store for which model backs each complexity tier of internal-use
 * LLM calls. Kept the same way `voice_config` is (see `db/schema.ts` for why):
 * at most one row, the most recent.
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

function rowToInput(row: ComplexityModelConfigRow): ComplexityModelConfigInput {
  return {
    low:
      row.lowProvider && row.lowModel ? { provider: row.lowProvider, model: row.lowModel } : null,
    medium:
      row.mediumProvider && row.mediumModel
        ? { provider: row.mediumProvider, model: row.mediumModel }
        : null,
    max:
      row.maxProvider && row.maxModel ? { provider: row.maxProvider, model: row.maxModel } : null,
  };
}

async function getRow(db: Db): Promise<ComplexityModelConfigRow | null> {
  const [row] = await db
    .select()
    .from(complexityModelConfig)
    .orderBy(desc(complexityModelConfig.updatedAt))
    .limit(1);
  return row ?? null;
}

/** Returns the stored tier config, or all-unset when none has been saved. */
export async function getComplexityModelConfig(db: Db): Promise<ComplexityModelConfigInput> {
  const row = await getRow(db);
  return row ? rowToInput(row) : { ...DEFAULT_COMPLEXITY_MODEL_CONFIG };
}

/**
 * Upserts one or more tiers, updating in place when a row already exists.
 * Every field is optional so the settings UI can save one tier at a time; a
 * tier explicitly set to `null` clears it back to "unset".
 */
export async function saveComplexityModelConfig(
  db: Db,
  input: Partial<ComplexityModelConfigInput>,
): Promise<ComplexityModelConfigInput> {
  const patch: Record<string, string> = {};
  if ("low" in input) {
    patch.lowProvider = input.low?.provider ?? "";
    patch.lowModel = input.low?.model ?? "";
  }
  if ("medium" in input) {
    patch.mediumProvider = input.medium?.provider ?? "";
    patch.mediumModel = input.medium?.model ?? "";
  }
  if ("max" in input) {
    patch.maxProvider = input.max?.provider ?? "";
    patch.maxModel = input.max?.model ?? "";
  }

  const existing = await getRow(db);
  if (existing) {
    await db
      .update(complexityModelConfig)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(complexityModelConfig.id, existing.id));
  } else {
    await db.insert(complexityModelConfig).values(patch);
  }
  return getComplexityModelConfig(db);
}

/**
 * Resolves the provider/model for a tier, falling back to the general default
 * chat model when that tier is unset — the same fallback a specialist with no
 * `model:` of its own uses today, so configuring nothing changes nothing.
 */
export async function resolveComplexityModel(
  config: Config,
  db: Db,
  tier: ComplexityTier,
): Promise<ModelSelection | null> {
  const stored = (await getComplexityModelConfig(db))[tier];
  return stored ?? (await defaultProviderModel(config, db));
}
