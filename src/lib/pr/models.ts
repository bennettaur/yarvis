import { ensureOk, sidecarFetch } from "../api";
import type { ModelSelection } from "../complexityModels";
import { type Resource, useCachedResource } from "../resourceCache";
import type { ReportSection } from "../reviewWorkspaces/verification";

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
 * Each verification section takes a Claude Code model alias and effort rather
 * than a provider/model pair. On an OpenCode harness the alias is a tier that
 * `harnessModels` maps to an OpenCode model, and effort doesn't apply. The budget
 * only warns: a run estimated over it asks first, and nothing stops it once
 * agreed.
 */
export const VERIFICATION_MODELS = ["sonnet", "opus", "haiku"] as const;

export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

export const VERIFICATION_MODEL_LABELS: Record<VerificationModel, string> = {
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
  haiku: "Claude Haiku",
};

/** Claude Code's `--effort` levels; mirrors `CLAUDE_EFFORTS` in `sidecar/src/lib/claudeCli.ts`. */
export const VERIFICATION_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export type VerificationEffort = (typeof VERIFICATION_EFFORTS)[number];

/** A model and effort for a run; either left out means "whatever applies otherwise". */
export interface RunChoice {
  model?: VerificationModel;
  effort?: VerificationEffort;
}

export interface VerificationRunConfig {
  maxBudgetUsd: number;
  /** The user's overrides, by section name. */
  sections: Partial<Record<ReportSection, RunChoice>>;
  /** The agent harness the checks run with; left out, the built-in agent. */
  harness?: string;
  /**
   * By harness id: the OpenCode model an OpenCode harness runs each tier on,
   * since a section's model is a Claude Code alias.
   */
  harnessModels?: Record<string, HarnessModels>;
  /** The harnesses a check can run with: the built-in agent first, then saved Claude Code and OpenCode ones. */
  harnesses: { id: string; name: string; kind: "claude-code" | "opencode" }[];
  /** Every section, in report order, with what it runs on when not overridden. */
  sectionDefaults: {
    section: ReportSection;
    label: string;
    model: VerificationModel;
    effort: VerificationEffort;
  }[];
}

export interface VerificationRunConfigPatch {
  maxBudgetUsd?: number;
  /** Replaces each named section's override; an empty one puts it back on its default. */
  sections?: Partial<Record<ReportSection, RunChoice>>;
  /** `null` goes back to the built-in agent. */
  harness?: string | null;
  /** Replaces each named harness's tiers; `null` clears them. */
  harnessModels?: Record<string, HarnessModels | null>;
}

/** The OpenCode model a harness runs each tier on, as `provider/model` with an optional `#variant`. */
export type HarnessModels = Partial<Record<VerificationModel, string>>;

/** Mirrors `openCodeModelSchema` in `sidecar/src/pr/models.ts`. */
export const OPENCODE_MODEL_PATTERN = /^[A-Za-z0-9][\w.-]*\/[^\s#]+(#[\w.-]+)?$/;

/** Cache key for the verification settings; Settings invalidates it on save. */
export const VERIFICATION_SETTINGS_KEY = "pr-models:verification";

/** The verification settings, cached for the tabs that show the harness choice. */
export function useVerificationSettings(): Resource<VerificationRunConfig> {
  return useCachedResource(VERIFICATION_SETTINGS_KEY, getVerificationRunConfig);
}

/** Mirrors `VERIFICATION_BUDGET_MIN_USD` in `sidecar/src/pr/models.ts`. */
export const VERIFICATION_BUDGET_MIN_USD = 0.25;

export async function getVerificationRunConfig(): Promise<VerificationRunConfig> {
  const res = await sidecarFetch("/api/pr-models/verification");
  await ensureOk(res, "verification report settings");
  return res.json();
}

/** Saves the given fields, leaving the rest as they are. */
export async function saveVerificationRunConfig(
  patch: VerificationRunConfigPatch,
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
export interface RereviewRunConfig {
  model: VerificationModel;
  maxBudgetUsd: number;
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
