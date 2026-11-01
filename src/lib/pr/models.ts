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

/**
 * The verification report runs on Claude Code, so it takes a Claude Code
 * model alias and a budget rather than a provider/model pair. The budget only
 * warns: a run estimated over it asks first, and nothing stops it once agreed.
 */
export const VERIFICATION_MODELS = ["sonnet", "opus", "haiku"] as const;

export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

export interface VerificationRunConfig {
  model: VerificationModel;
  maxBudgetUsd: number;
}

/** Mirrors `verificationRunConfigSchema` in `sidecar/src/pr/models.ts`. */
export const VERIFICATION_BUDGET_MIN_USD = 0.25;

export async function getVerificationRunConfig(): Promise<VerificationRunConfig> {
  const res = await sidecarFetch("/api/pr-models/verification");
  await ensureOk(res, "verification report settings");
  return res.json();
}

/** Saves the given fields, leaving the rest as they are. */
export async function saveVerificationRunConfig(
  patch: Partial<VerificationRunConfig>,
): Promise<VerificationRunConfig> {
  const res = await sidecarFetch("/api/pr-models/verification", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save verification report settings");
  return res.json();
}

/**
 * The "What's changed" summary on a re-review: a Claude Code model, its own
 * budget, and whether it starts by itself when the tab opens.
 */
export interface RereviewRunConfig extends VerificationRunConfig {
  autoStart: boolean;
}

export async function getRereviewRunConfig(): Promise<RereviewRunConfig> {
  const res = await sidecarFetch("/api/pr-models/rereview");
  await ensureOk(res, "re-review summary settings");
  return res.json();
}

/** Saves the given fields, leaving the rest as they are. */
export async function saveRereviewRunConfig(
  patch: Partial<RereviewRunConfig>,
): Promise<RereviewRunConfig> {
  const res = await sidecarFetch("/api/pr-models/rereview", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save re-review summary settings");
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
