import { type ReactNode, useCallback, useEffect, useState } from "react";
import { listProviders, type ProviderInfo } from "../lib/chat";
import type { ModelSelection } from "../lib/complexityModels";
import {
  DEFAULT_PR_MODEL_CONFIG,
  getPrModelConfig,
  getRereviewRunConfig,
  getVerificationRunConfig,
  PR_MODEL_FEATURES,
  type PrModelConfig,
  type PrModelFeature,
  type RereviewRunConfig,
  savePrModelConfig,
  saveRereviewRunConfig,
  saveVerificationRunConfig,
  VERIFICATION_BUDGET_MIN_USD,
  VERIFICATION_MODELS,
  type VerificationModel,
  type VerificationRunConfig,
} from "../lib/pr/models";

/**
 * Which model writes guided reviews and answers line questions about a pull request's
 * code. A feature left unset uses the default chat model. The verification report and
 * the "What's changed" summary run on Claude Code instead, so each takes a Claude Code
 * model and a budget.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

const FEATURE_LABELS: Record<PrModelFeature, { label: string; hint: string }> = {
  guide: { label: "Guided review", hint: "Reads the whole change and plans the walkthrough." },
  ask: { label: "Line questions", hint: "Answers a question about the lines you selected." },
};

const VERIFICATION_MODEL_LABELS: Record<VerificationModel, string> = {
  sonnet: "Claude Sonnet",
  opus: "Claude Opus",
  haiku: "Claude Haiku",
};

/**
 * A feature that runs on Claude Code: its model and budget, and whatever else
 * `children` adds. The budget is saved on blur, so a half-typed number isn't
 * sent, and one below the minimum is refused and put back.
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
  value: VerificationRunConfig;
  onSave: (patch: Partial<VerificationRunConfig>) => void;
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

  const saveVerification = useCallback(async (patch: Partial<VerificationRunConfig>) => {
    try {
      setVerification(await saveVerificationRunConfig(patch));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
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
            hint="Runs on Claude Code. A report estimated over the budget asks before it starts."
            value={verification}
            onSave={(patch) => void saveVerification(patch)}
            onError={setError}
          />
        )}
        {rereview && (
          <ClaudeRunRow
            label="What's changed"
            hint="Re-review summary, on Claude Code. One estimated over the budget asks first."
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
