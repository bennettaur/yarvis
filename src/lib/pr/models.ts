import { ensureOk, sidecarFetch } from "../api";
import type { ModelSelection } from "../complexityModels";

/**
 * Which provider/model backs each PR review feature. Lives server-side, like
 * `complexityModels.ts`, because the sidecar picks the model when it runs the
 * tour or answers a question.
 */

export const PR_MODEL_FEATURES = ["guide", "ask"] as const;

/** `guide` writes the guided review (the tour); `ask` answers line questions. */
export type PrModelFeature = (typeof PR_MODEL_FEATURES)[number];

export type PrModelConfig = Record<PrModelFeature, ModelSelection | null>;

export const DEFAULT_PR_MODEL_CONFIG: PrModelConfig = {
  guide: null,
  ask: null,
};

export async function getPrModelConfig(): Promise<PrModelConfig> {
  const res = await sidecarFetch("/api/pr-models");
  await ensureOk(res, "PR model config");
  return res.json();
}

/** Saves the given features, leaving the rest as they are; `null` clears one. */
export async function savePrModelConfig(patch: Partial<PrModelConfig>): Promise<PrModelConfig> {
  const res = await sidecarFetch("/api/pr-models", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save PR model config");
  return res.json();
}
