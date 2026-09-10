import { ensureOk, sidecarFetch } from "./api";

/**
 * Which provider/model backs each complexity tier for internal-use LLM
 * calls — specialists like the session summarizer and activity consolidator,
 * not the chat the user is talking to. Lives server-side, like `voiceConfig.ts`,
 * because the background jobs run in the sidecar and need the same settings a
 * browser's localStorage can't reach.
 */

export const COMPLEXITY_TIERS = ["low", "medium", "max"] as const;

export type ComplexityTier = (typeof COMPLEXITY_TIERS)[number];

export interface ModelSelection {
  provider: string;
  model: string;
}

export type ComplexityModelConfig = Record<ComplexityTier, ModelSelection | null>;

export const DEFAULT_COMPLEXITY_MODEL_CONFIG: ComplexityModelConfig = {
  low: null,
  medium: null,
  max: null,
};

export async function getComplexityModelConfig(): Promise<ComplexityModelConfig> {
  const res = await sidecarFetch("/api/complexity-models");
  await ensureOk(res, "complexity model config");
  return res.json();
}

/** Saves the given tiers, leaving the rest as they are; `null` clears a tier. */
export async function saveComplexityModelConfig(
  patch: Partial<ComplexityModelConfig>,
): Promise<ComplexityModelConfig> {
  const res = await sidecarFetch("/api/complexity-models", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save complexity model config");
  return res.json();
}
