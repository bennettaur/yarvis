import { useCallback, useEffect, useState } from "react";
import { listProviders, type ProviderInfo } from "../lib/chat";
import type { ModelSelection } from "../lib/complexityModels";
import {
  DEFAULT_PR_MODEL_CONFIG,
  getPrModelConfig,
  getVerificationRunConfig,
  PR_MODEL_FEATURES,
  type PrModelConfig,
  type PrModelFeature,
  savePrModelConfig,
  saveVerificationRunConfig,
  VERIFICATION_BUDGET_LIMITS,
  VERIFICATION_MODELS,
  type VerificationModel,
  type VerificationRunConfig,
} from "../lib/pr/models";

/**
 * Which model writes guided reviews and answers line questions about a pull request's
 * code. A feature left unset uses the default chat model. The verification report runs
 * on Claude Code instead, so it takes a Claude Code model and a spend ceiling.
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

export default function PrModelSection() {
  const [config, setConfig] = useState<PrModelConfig>(DEFAULT_PR_MODEL_CONFIG);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [verification, setVerification] = useState<VerificationRunConfig | null>(null);
  /** The budget as typed; saved on blur, so a half-typed number isn't sent. */
  const [budgetDraft, setBudgetDraft] = useState("");
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [saved, catalog, run] = await Promise.all([
        getPrModelConfig(),
        listProviders("chat"),
        getVerificationRunConfig(),
      ]);
      setConfig(saved);
      setProviders(catalog);
      setVerification(run);
      setBudgetDraft(String(run.maxBudgetUsd));
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
      const saved = await saveVerificationRunConfig(patch);
      setVerification(saved);
      setBudgetDraft(String(saved.maxBudgetUsd));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const commitBudget = () => {
    if (!verification) return;
    const value = Number(budgetDraft);
    if (
      budgetDraft.trim() === "" ||
      !Number.isFinite(value) ||
      value < VERIFICATION_BUDGET_LIMITS.min ||
      value > VERIFICATION_BUDGET_LIMITS.max
    ) {
      setBudgetDraft(String(verification.maxBudgetUsd));
      setError(
        `The budget must be between $${VERIFICATION_BUDGET_LIMITS.min} and $${VERIFICATION_BUDGET_LIMITS.max}.`,
      );
      return;
    }
    if (value !== verification.maxBudgetUsd) void saveVerification({ maxBudgetUsd: value });
  };

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
          <div className="grid grid-cols-[120px_1fr_1fr] items-start gap-2">
            <div>
              <p className="text-sm text-zinc-300">Verification report</p>
              <p className="text-xs text-zinc-600">
                Runs on Claude Code. The budget caps what one report may spend.
              </p>
            </div>
            <select
              className={FIELD}
              aria-label="Verification report model"
              value={verification.model}
              onChange={(e) =>
                void saveVerification({ model: e.target.value as VerificationModel })
              }
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
                aria-label="Verification report budget in US dollars"
                type="number"
                inputMode="decimal"
                min={VERIFICATION_BUDGET_LIMITS.min}
                max={VERIFICATION_BUDGET_LIMITS.max}
                step={0.25}
                value={budgetDraft}
                onChange={(e) => setBudgetDraft(e.target.value)}
                onBlur={commitBudget}
              />
            </label>
          </div>
        )}
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
