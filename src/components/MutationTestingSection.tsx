import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MUTATION_TESTING_CONFIG,
  getMutationTestingConfig,
  MUTATION_LIMITS,
  type MutationTestingConfig,
  saveMutationTestingConfig,
} from "../lib/pr/mutationTestingConfig";

/**
 * How a review workspace's mutation-testing runs are sized. They run on
 * Claude Code rather than the app's own providers, so the model is a Claude
 * Code model name, not a provider pick.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

const MODEL_ALIASES = ["haiku", "sonnet", "opus"];

export default function MutationTestingSection() {
  const [config, setConfig] = useState<MutationTestingConfig>(DEFAULT_MUTATION_TESTING_CONFIG);
  // Number inputs are edited as text and saved on blur, so a half-typed value
  // isn't sent (and refused) on every keystroke.
  const [budget, setBudget] = useState(String(DEFAULT_MUTATION_TESTING_CONFIG.maxBudgetUsd));
  const [mutants, setMutants] = useState(String(DEFAULT_MUTATION_TESTING_CONFIG.maxMutants));
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((next: MutationTestingConfig) => {
    setConfig(next);
    setBudget(String(next.maxBudgetUsd));
    setMutants(String(next.maxMutants));
  }, []);

  useEffect(() => {
    getMutationTestingConfig()
      .then((saved) => {
        show(saved);
        setError(null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [show]);

  const save = useCallback(
    async (patch: Partial<MutationTestingConfig>) => {
      try {
        show(await saveMutationTestingConfig(patch));
        setError(null);
      } catch (e) {
        // Put the saved values back, so nothing on screen looks saved that wasn't.
        show(config);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [config, show],
  );

  const commitNumber = (
    raw: string,
    key: "maxBudgetUsd" | "maxMutants",
    valid: (n: number) => boolean,
  ) => {
    const value = Number(raw);
    if (value === config[key]) return;
    if (!raw.trim() || !valid(value)) {
      show(config);
      setError(
        key === "maxMutants"
          ? `Mutants must be a whole number from 1 to ${MUTATION_LIMITS.maxMutants}.`
          : `The budget must be between $${MUTATION_LIMITS.minBudgetUsd} and $${MUTATION_LIMITS.maxBudgetUsd}.`,
      );
      return;
    }
    void save({ [key]: value });
  };

  const models =
    config.model && !MODEL_ALIASES.includes(config.model)
      ? [...MODEL_ALIASES, config.model]
      : MODEL_ALIASES;

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Mutation testing
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        Claude Code makes small logic changes to a pull request's code and checks its tests catch
        them. Each run uses this model and stops at its budget.
      </p>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <label className="grid grid-cols-[160px_1fr] items-center gap-2">
          <span className="text-sm text-zinc-300">Claude Code model</span>
          <select
            className={FIELD}
            value={config.model ?? ""}
            onChange={(e) => void save({ model: e.target.value || null })}
          >
            <option value="">Claude Code's default</option>
            {models.map((model) => (
              <option key={model} value={model}>
                {model}
              </option>
            ))}
          </select>
        </label>
        <label className="grid grid-cols-[160px_1fr] items-center gap-2">
          <span className="text-sm text-zinc-300">Budget per run (USD)</span>
          <input
            className={FIELD}
            type="number"
            inputMode="decimal"
            min={MUTATION_LIMITS.minBudgetUsd}
            max={MUTATION_LIMITS.maxBudgetUsd}
            step={0.5}
            value={budget}
            onChange={(e) => setBudget(e.target.value)}
            onBlur={() =>
              commitNumber(
                budget,
                "maxBudgetUsd",
                (n) => n >= MUTATION_LIMITS.minBudgetUsd && n <= MUTATION_LIMITS.maxBudgetUsd,
              )
            }
          />
        </label>
        <label className="grid grid-cols-[160px_1fr] items-center gap-2">
          <span className="text-sm text-zinc-300">Most mutants per run</span>
          <input
            className={FIELD}
            type="number"
            inputMode="numeric"
            min={1}
            max={MUTATION_LIMITS.maxMutants}
            step={1}
            value={mutants}
            onChange={(e) => setMutants(e.target.value)}
            onBlur={() =>
              commitNumber(
                mutants,
                "maxMutants",
                (n) => Number.isInteger(n) && n >= 1 && n <= MUTATION_LIMITS.maxMutants,
              )
            }
          />
        </label>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
