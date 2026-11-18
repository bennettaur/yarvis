import { z } from "zod";
import type { Config } from "../config.ts";
import { CLAUDE_EFFORTS } from "../lib/claudeCli.ts";
import type { ModelSelection } from "../llm/complexity.ts";
import { defaultProviderModel } from "../llm/providers.ts";
import { readSection, withSection } from "../settings/store.ts";
import { harnessIdSchema } from "../workspaces/harnesses.ts";

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
 * so it takes Claude Code model aliases and a budget instead of a
 * provider/model pair. Kept under its own `prVerification` key.
 *
 * Each section runs on a model and effort matched to its job
 * (`SECTION_RUN_DEFAULTS` in `reviewWorkspaces/verification.ts`); `sections`
 * holds the user's overrides of those, by section name.
 *
 * The budget is a warning threshold, not a cap: a run estimated over it asks
 * the user first, and once they agree it runs to the end whatever it costs.
 * `maxBudgetUsd` is not a maximum; it keeps that name because it is the
 * stored settings key.
 */
export const VERIFICATION_MODELS = ["sonnet", "opus", "haiku"] as const;

export type VerificationModel = (typeof VERIFICATION_MODELS)[number];

/** A model and effort for a run; either left out means "whatever applies otherwise". */
export const runChoiceSchema = z.object({
  model: z.enum(VERIFICATION_MODELS).optional(),
  effort: z.enum(CLAUDE_EFFORTS).optional(),
});

export type RunChoice = z.infer<typeof runChoiceSchema>;

/** `VERIFICATION_BUDGET_MIN_USD` in `src/lib/pr/models.ts` mirrors this. */
const VERIFICATION_BUDGET_MIN_USD = 0.25;

export const verificationBudgetSchema = z.number().min(VERIFICATION_BUDGET_MIN_USD);

export interface VerificationRunConfig {
  maxBudgetUsd: number;
  /** Overrides by section name. The route checks the names; one stored by hand that names no section is never read. */
  sections: Record<string, RunChoice>;
  /**
   * The agent harness the checks run with, by id; left out, the built-in
   * agent. It must be a Claude Code harness, which the core checks when it
   * hands over the harness's environment.
   */
  harness?: string;
}

export const DEFAULT_VERIFICATION_RUN_CONFIG: VerificationRunConfig = {
  maxBudgetUsd: 2,
  sections: {},
};

const VERIFICATION_SETTINGS_KEY = "prVerification";

/** Each stored override's fields that still validate, with empty overrides dropped. */
function sectionsFrom(stored: unknown): Record<string, RunChoice> {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const { model: modelSchema, effort: effortSchema } = runChoiceSchema.shape;
  const sections: Record<string, RunChoice> = {};
  for (const [section, value] of Object.entries(stored)) {
    const fields = (value ?? {}) as Record<string, unknown>;
    const model = modelSchema.safeParse(fields.model).data;
    const effort = effortSchema.safeParse(fields.effort).data;
    if (model || effort) {
      sections[section] = { ...(model && { model }), ...(effort && { effort }) };
    }
  }
  return sections;
}

/**
 * The stored verification settings over the defaults. A stored field that no
 * longer validates (a hand edit, an alias since dropped) falls back to its
 * default rather than failing every run. A `model` stored before sections had
 * their own is ignored.
 */
function verificationConfigFrom(
  stored: Record<string, unknown> | undefined,
): VerificationRunConfig {
  const budget = verificationBudgetSchema.safeParse(stored?.maxBudgetUsd);
  const harness = harnessIdSchema.safeParse(stored?.harness).data;
  return {
    maxBudgetUsd: budget.success ? budget.data : DEFAULT_VERIFICATION_RUN_CONFIG.maxBudgetUsd,
    sections: sectionsFrom(stored?.sections),
    ...(harness && { harness }),
  };
}

export async function getVerificationRunConfig(): Promise<VerificationRunConfig> {
  return verificationConfigFrom(await readSection(VERIFICATION_SETTINGS_KEY));
}

interface VerificationRunConfigPatch {
  maxBudgetUsd?: number;
  /** Replaces each named section's override; an empty one puts the section back on its default. */
  sections?: Record<string, RunChoice>;
  /** `null` goes back to the built-in agent. */
  harness?: string | null;
}

/** Merges the given fields onto the stored settings and writes them back. */
export async function saveVerificationRunConfig(
  input: VerificationRunConfigPatch,
): Promise<VerificationRunConfig> {
  return withSection<Record<string, unknown>, VerificationRunConfig>(
    VERIFICATION_SETTINGS_KEY,
    (current) => {
      const before = verificationConfigFrom(current);
      const harness = input.harness === undefined ? before.harness : input.harness;
      const next = {
        maxBudgetUsd: input.maxBudgetUsd ?? before.maxBudgetUsd,
        sections: sectionsFrom({ ...before.sections, ...input.sections }),
        ...(harness && { harness }),
      };
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
export const rereviewRunConfigSchema = z.object({
  model: z.enum(VERIFICATION_MODELS),
  maxBudgetUsd: verificationBudgetSchema,
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
