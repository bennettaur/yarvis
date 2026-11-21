import { type ReactNode, useCallback, useEffect, useState } from "react";
import { listProviders, type ProviderInfo } from "../lib/chat";
import type { ModelSelection } from "../lib/complexityModels";
import {
  DEFAULT_PR_MODEL_CONFIG,
  getPrModelConfig,
  getRereviewRunConfig,
  getVerificationRunConfig,
  HARNESS_MODEL_PATTERN,
  type HarnessModels,
  PR_MODEL_FEATURES,
  type PrModelConfig,
  type PrModelFeature,
  type RereviewRunConfig,
  type RunChoice,
  savePrModelConfig,
  saveRereviewRunConfig,
  saveVerificationRunConfig,
  VERIFICATION_BUDGET_MIN_USD,
  VERIFICATION_EFFORTS,
  VERIFICATION_MODEL_LABELS,
  VERIFICATION_MODELS,
  VERIFICATION_SETTINGS_KEY,
  type VerificationEffort,
  type VerificationModel,
  type VerificationRunConfig,
  type VerificationRunConfigPatch,
} from "../lib/pr/models";
import { invalidate } from "../lib/resourceCache";
import type { ReportSection } from "../lib/reviewWorkspaces/verification";
import { BUILTIN_HARNESS_ID } from "../lib/settings";

/**
 * Which model writes guided reviews and answers line questions about a pull request's
 * code. A feature left unset uses the default chat model. The verification report and
 * the "What's changed" summary run on Claude Code instead, so they take Claude Code
 * models and a budget: the summary one model, the report a model and effort per check.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

const FEATURE_LABELS: Record<PrModelFeature, { label: string; hint: string }> = {
  guide: { label: "Guided review", hint: "Reads the whole change and plans the walkthrough." },
  ask: { label: "Line questions", hint: "Answers a question about the lines you selected." },
};

/**
 * A feature that runs on Claude Code: its budget, its model when it has one,
 * and whatever else `children` adds. The budget is saved on blur, so a
 * half-typed number isn't sent, and one below the minimum is refused and put
 * back.
 */
function ClaudeRunRow({
  label,
  hint,
  value,
  onSave,
  onError,
  children,
}: {
  label: string;
  hint: string;
  value: { model?: VerificationModel; maxBudgetUsd: number };
  onSave: (patch: { model?: VerificationModel; maxBudgetUsd?: number }) => void;
  onError: (message: string) => void;
  children?: ReactNode;
}) {
  const [budgetDraft, setBudgetDraft] = useState(String(value.maxBudgetUsd));
  useEffect(() => setBudgetDraft(String(value.maxBudgetUsd)), [value.maxBudgetUsd]);

  const commitBudget = () => {
    const budget = Number(budgetDraft);
    if (
      budgetDraft.trim() === "" ||
      !Number.isFinite(budget) ||
      budget < VERIFICATION_BUDGET_MIN_USD
    ) {
      setBudgetDraft(String(value.maxBudgetUsd));
      onError(`The budget must be at least $${VERIFICATION_BUDGET_MIN_USD}.`);
      return;
    }
    if (budget !== value.maxBudgetUsd) onSave({ maxBudgetUsd: budget });
  };

  return (
    <div className="grid grid-cols-[120px_1fr_1fr] items-start gap-2">
      <div>
        <p className="text-sm text-zinc-300">{label}</p>
        <p className="text-xs text-zinc-600">{hint}</p>
      </div>
      {value.model && (
        <select
          className={FIELD}
          aria-label={`${label} model`}
          value={value.model}
          onChange={(e) => onSave({ model: e.target.value as VerificationModel })}
        >
          {VERIFICATION_MODELS.map((m) => (
            <option key={m} value={m}>
              {VERIFICATION_MODEL_LABELS[m]}
            </option>
          ))}
        </select>
      )}
      <label className="flex items-center gap-1 text-sm text-zinc-500">
        $
        <input
          className={FIELD}
          aria-label={`${label} budget in US dollars`}
          type="number"
          inputMode="decimal"
          min={VERIFICATION_BUDGET_MIN_USD}
          step={0.25}
          value={budgetDraft}
          onChange={(e) => setBudgetDraft(e.target.value)}
          onBlur={commitBudget}
        />
      </label>
      {children && <div className="col-start-2 col-end-4">{children}</div>}
    </div>
  );
}

const NO_MODELS: HarnessModels = {};

/** Each tier's name and what it stands for, so a harness's model can be picked to match it. */
const TIERS: Record<VerificationModel, { name: string; hint: string }> = {
  opus: { name: "Opus", hint: "the hardest checks (risk, malicious intent)" },
  sonnet: { name: "Sonnet", hint: "most checks" },
  haiku: { name: "Haiku", hint: "the lightest checks (comments, observability)" },
};

/** The CLIs that take a model per tier, by harness kind, and how each takes an effort. */
const TIER_CLIS = {
  opencode: {
    name: "OpenCode",
    effort: (
      <>
        Add <code>#variant</code> (e.g. <code>#high</code>) for a reasoning effort
      </>
    ),
  },
  pi: {
    name: "Pi",
    effort: (
      <>
        Add <code>:level</code> (e.g. <code>:high</code>) for a thinking level
      </>
    ),
  },
} as const;

/**
 * The model an OpenCode or Pi harness runs each tier on. A field is saved
 * when it loses focus, and only once it reads as `provider/model`; clearing it
 * leaves the checks on that tier unable to start until one is picked.
 */
function TierModels({
  cli,
  harness,
  models,
  onSave,
}: {
  cli: keyof typeof TIER_CLIS;
  harness: string;
  models: HarnessModels;
  onSave: (patch: VerificationRunConfigPatch) => void;
}) {
  const [drafts, setDrafts] = useState<HarnessModels>(models);
  const [editing, setEditing] = useState<VerificationModel | null>(null);
  // Saved values replace the drafts, but never the one being typed in.
  const saved = JSON.stringify(models);
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on the saved values, not the object
  useEffect(() => {
    setDrafts((prev) => ({
      ...models,
      ...(editing && prev[editing] !== undefined && { [editing]: prev[editing] }),
    }));
  }, [saved]);
  const commit = (tier: VerificationModel) => {
    setEditing(null);
    const draft = drafts[tier]?.trim() ?? "";
    if (draft === (models[tier] ?? "")) return;
    if (draft && !HARNESS_MODEL_PATTERN.test(draft)) return;
    const next: HarnessModels = { ...models };
    if (draft) next[tier] = draft;
    else delete next[tier];
    onSave({ harnessModels: { [harness]: next } });
  };
  return (
    <div className="space-y-1">
      <p className="text-xs text-zinc-500">
        {TIER_CLIS[cli].name} models for each tier, as <code>provider/model</code>.{" "}
        {TIER_CLIS[cli].effort}: the effort choices below don't apply to {TIER_CLIS[cli].name}.
      </p>
      <div className="grid grid-cols-[auto_1fr] items-center gap-x-2 gap-y-1">
        {VERIFICATION_MODELS.map((tier) => {
          const draft = drafts[tier] ?? "";
          const invalid = draft.trim() !== "" && !HARNESS_MODEL_PATTERN.test(draft.trim());
          return (
            <label key={tier} className="contents">
              <span className="text-xs text-zinc-400" title={TIERS[tier].hint}>
                {TIERS[tier].name} tier
              </span>
              <input
                className={FIELD}
                aria-label={`${TIER_CLIS[cli].name} model for the ${TIERS[tier].name} tier`}
                aria-invalid={invalid}
                placeholder="provider/model"
                value={draft}
                onChange={(e) => setDrafts((prev) => ({ ...prev, [tier]: e.target.value }))}
                onFocus={() => setEditing(tier)}
                onBlur={() => commit(tier)}
              />
              {invalid && (
                <span className="col-start-2 text-xs text-red-400">
                  Not saved: write it as provider/model
                </span>
              )}
            </label>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Each verification check's model and effort. "Default" leaves a check on what
 * Yarvis picked for it; choosing the default value explicitly pins it there.
 */
function VerificationSectionRuns({
  value,
  onSave,
}: {
  value: VerificationRunConfig;
  onSave: (patch: VerificationRunConfigPatch) => void;
}) {
  // A harness deleted or changed since it was picked: shown, so it can be changed.
  const missingHarness =
    value.harness && !value.harnesses.some((h) => h.id === value.harness) ? value.harness : null;
  const save = (section: ReportSection, choice: RunChoice) =>
    onSave({ sections: { [section]: choice } });
  const picked = value.harnesses.find((h) => h.id === (value.harness ?? BUILTIN_HARNESS_ID));
  const tierCli = picked?.kind === "opencode" || picked?.kind === "pi" ? picked.kind : null;
  return (
    <div className="space-y-1">
      {(value.harnesses.length > 1 || missingHarness) && (
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Run the checks with
          <select
            className={FIELD}
            aria-label="Verification harness"
            value={value.harness ?? BUILTIN_HARNESS_ID}
            onChange={(e) =>
              onSave({ harness: e.target.value === BUILTIN_HARNESS_ID ? null : e.target.value })
            }
          >
            {value.harnesses.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
            {missingHarness && (
              <option value={missingHarness}>
                {missingHarness} (no longer saved; checks fail)
              </option>
            )}
          </select>
        </label>
      )}
      {picked && tierCli && (
        <TierModels
          key={picked.id}
          cli={tierCli}
          harness={picked.id}
          models={value.harnessModels?.[picked.id] ?? NO_MODELS}
          onSave={onSave}
        />
      )}
      <p className="text-xs text-zinc-500">
        {tierCli
          ? `Each check's tier, which runs on the ${TIER_CLIS[tierCli].name} model above, and effort, which applies only to Claude Code.`
          : "Each check's Claude model and effort."}{" "}
        A run started from the checklist or the assistant can override them for that run.
      </p>
      <div className="grid grid-cols-[1fr_1fr_1fr] items-center gap-x-2 gap-y-1">
        {value.sectionDefaults.map((check) => {
          const saved = value.sections[check.section] ?? {};
          return (
            <div key={check.section} className="contents">
              <span className="text-xs text-zinc-400">{check.label}</span>
              <select
                className={FIELD}
                aria-label={`${check.label} model`}
                value={saved.model ?? ""}
                onChange={(e) =>
                  save(check.section, {
                    ...saved,
                    model: (e.target.value || undefined) as VerificationModel | undefined,
                  })
                }
              >
                <option value="">Default ({VERIFICATION_MODEL_LABELS[check.model]})</option>
                {VERIFICATION_MODELS.map((m) => (
                  <option key={m} value={m}>
                    {VERIFICATION_MODEL_LABELS[m]}
                  </option>
                ))}
              </select>
              <select
                className={FIELD}
                aria-label={`${check.label} effort`}
                value={saved.effort ?? ""}
                onChange={(e) =>
                  save(check.section, {
                    ...saved,
                    effort: (e.target.value || undefined) as VerificationEffort | undefined,
                  })
                }
              >
                <option value="">Default ({check.effort} effort)</option>
                {VERIFICATION_EFFORTS.map((effort) => (
                  <option key={effort} value={effort}>
                    {effort} effort
                  </option>
                ))}
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export default function PrModelSection() {
  const [config, setConfig] = useState<PrModelConfig>(DEFAULT_PR_MODEL_CONFIG);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [verification, setVerification] = useState<VerificationRunConfig | null>(null);
  const [rereview, setRereview] = useState<RereviewRunConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [saved, catalog, run, rerun] = await Promise.all([
        getPrModelConfig(),
        listProviders("chat"),
        getVerificationRunConfig(),
        getRereviewRunConfig(),
      ]);
      setConfig(saved);
      setProviders(catalog);
      setVerification(run);
      setRereview(rerun);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (feature: PrModelFeature, selection: ModelSelection | null) => {
      setConfig((prev) => ({ ...prev, [feature]: selection }));
      try {
        setConfig(await savePrModelConfig({ [feature]: selection }));
        setError(null);
      } catch (e) {
        // Revert the optimistic update: a selection left on screen next to an
        // error would otherwise look saved when it wasn't.
        setConfig((prev) => ({ ...prev, [feature]: config[feature] }));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [config],
  );

  const saveVerification = useCallback(async (patch: VerificationRunConfigPatch) => {
    // Shown at once, so a second change made before this save returns builds on it.
    setVerification(
      (prev) =>
        prev && {
          ...prev,
          ...(patch.maxBudgetUsd !== undefined && { maxBudgetUsd: patch.maxBudgetUsd }),
          sections: { ...prev.sections, ...patch.sections },
          ...(patch.harnessModels && {
            harnessModels: Object.fromEntries(
              Object.entries({ ...prev.harnessModels, ...patch.harnessModels }).filter(
                (entry): entry is [string, HarnessModels] => entry[1] !== null,
              ),
            ),
          }),
        },
    );
    try {
      setVerification(await saveVerificationRunConfig(patch));
      invalidate(VERIFICATION_SETTINGS_KEY);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // Put back what is saved, so the failed change doesn't look saved.
      void getVerificationRunConfig()
        .then(setVerification)
        .catch(() => undefined);
    }
  }, []);

  const saveRereview = useCallback(async (patch: Partial<RereviewRunConfig>) => {
    try {
      setRereview(await saveRereviewRunConfig(patch));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const modelsFor = (providerId: string) =>
    providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Review models
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        The model behind each AI feature in a pull request review.
      </p>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        {PR_MODEL_FEATURES.map((feature) => {
          const selection = config[feature];
          return (
            <div key={feature} className="grid grid-cols-[120px_1fr_1fr] items-start gap-2">
              <div>
                <p className="text-sm text-zinc-300">{FEATURE_LABELS[feature].label}</p>
                <p className="text-xs text-zinc-600">{FEATURE_LABELS[feature].hint}</p>
              </div>
              <select
                className={FIELD}
                value={selection?.provider ?? ""}
                onChange={(e) => {
                  const provider = e.target.value;
                  if (!provider) {
                    void save(feature, null);
                    return;
                  }
                  const model = modelsFor(provider)[0]?.id ?? "";
                  void save(feature, model ? { provider, model } : null);
                }}
              >
                <option value="">Default chat model</option>
                {providers.map((p) => (
                  <option key={p.id} value={p.id} disabled={!p.available}>
                    {p.label}
                    {p.available ? "" : " (no key)"}
                  </option>
                ))}
              </select>
              <select
                className={FIELD}
                value={selection?.model ?? ""}
                disabled={!selection?.provider}
                onChange={(e) => {
                  if (!selection?.provider) return;
                  void save(feature, { provider: selection.provider, model: e.target.value });
                }}
              >
                {modelsFor(selection?.provider ?? "").map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.id}
                  </option>
                ))}
              </select>
            </div>
          );
        })}
        {verification && (
          <ClaudeRunRow
            label="Verification report"
            hint="Runs on Claude Code, or the OpenCode or Pi harness picked below. The assistant asks before starting a report estimated over the budget."
            value={{ maxBudgetUsd: verification.maxBudgetUsd }}
            onSave={({ maxBudgetUsd }) => void saveVerification({ maxBudgetUsd })}
            onError={setError}
          >
            <VerificationSectionRuns
              value={verification}
              onSave={(patch) => void saveVerification(patch)}
            />
          </ClaudeRunRow>
        )}
        {rereview && (
          <ClaudeRunRow
            label="What's changed"
            hint="Re-review summary, on Claude Code. A summary estimated over the budget asks before it starts."
            value={rereview}
            onSave={(patch) => void saveRereview(patch)}
            onError={setError}
          >
            <label className="flex items-center gap-2 text-xs text-zinc-400">
              <input
                type="checkbox"
                checked={rereview.autoStart}
                onChange={(e) => void saveRereview({ autoStart: e.target.checked })}
              />
              Start it when "Since last review" opens on changes it hasn't summarised
            </label>
          </ClaudeRunRow>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
