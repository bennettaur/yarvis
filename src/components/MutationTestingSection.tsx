import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_MUTATION_TESTING_CONFIG,
  getMutationTestingConfig,
  MUTATION_LIMITS,
  type MutationTestingConfig,
  saveMutationTestingConfig,
} from "../lib/pr/mutationTestingConfig";

/**
 * How a review workspace's mutation-testing passes are sized. Planning and
 * explaining run on Claude Code rather than the app's own providers, so their
 * models are Claude Code model names, not provider picks.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

const MODEL_ALIASES = ["haiku", "sonnet", "opus"];

type ModelKey = "planningModel" | "explanationModel";
type NumberKey = keyof typeof MUTATION_LIMITS;

const NUMBER_FIELDS: { key: NumberKey; label: string; step: number; integer: boolean }[] = [
  { key: "planningBudgetUsd", label: "Planning budget (USD)", step: 0.5, integer: false },
  { key: "explanationBudgetUsd", label: "Explanation budget (USD)", step: 0.25, integer: false },
  { key: "maxMutants", label: "Most mutants per run", step: 1, integer: true },
  { key: "testTimeoutCapSeconds", label: "Longest test run (seconds)", step: 30, integer: true },
];

const asDrafts = (config: MutationTestingConfig): Record<NumberKey, string> => ({
  planningBudgetUsd: String(config.planningBudgetUsd),
  explanationBudgetUsd: String(config.explanationBudgetUsd),
  maxMutants: String(config.maxMutants),
  testTimeoutCapSeconds: String(config.testTimeoutCapSeconds),
});

export default function MutationTestingSection() {
  const [config, setConfig] = useState<MutationTestingConfig>(DEFAULT_MUTATION_TESTING_CONFIG);
  // Number inputs are edited as text and saved on blur, so a half-typed value
  // isn't sent (and refused) on every keystroke.
  const [drafts, setDrafts] = useState(asDrafts(DEFAULT_MUTATION_TESTING_CONFIG));
  const [error, setError] = useState<string | null>(null);

  const show = useCallback((next: MutationTestingConfig) => {
    setConfig(next);
    setDrafts(asDrafts(next));
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

  const commitNumber = (key: NumberKey, integer: boolean) => {
    const raw = drafts[key];
    const value = Number(raw);
    if (value === config[key]) return;
    const { min, max } = MUTATION_LIMITS[key];
    if (
      !raw.trim() ||
      Number.isNaN(value) ||
      value < min ||
      (max !== undefined && value > max) ||
      (integer && !Number.isInteger(value))
    ) {
      show(config);
      const label = NUMBER_FIELDS.find((f) => f.key === key)?.label;
      setError(
        max === undefined
          ? `${label} must be at least ${min}.`
          : `${label} must be from ${min} to ${max}.`,
      );
      return;
    }
    void save({ [key]: value });
  };

  const modelSelect = (key: ModelKey, label: string) => {
    const current = config[key];
    const models =
      current && !MODEL_ALIASES.includes(current) ? [...MODEL_ALIASES, current] : MODEL_ALIASES;
    return (
      <label className="grid grid-cols-[180px_1fr] items-center gap-2">
        <span className="text-sm text-zinc-300">{label}</span>
        <select
          className={FIELD}
          value={current ?? ""}
          onChange={(e) => void save({ [key]: e.target.value || null })}
        >
          <option value="">Claude Code's default</option>
          {models.map((model) => (
            <option key={model} value={model}>
              {model}
            </option>
          ))}
        </select>
      </label>
    );
  };

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Mutation testing
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        Claude Code plans small logic changes to a pull request's code; Yarvis applies each one,
        runs the tests in a sandbox and reports the ones they miss, which Claude Code then explains.
        The budgets are shown before a pass starts; a pass that goes over them still finishes.
      </p>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        {modelSelect("planningModel", "Planning model")}
        {modelSelect("explanationModel", "Explanation model")}
        {NUMBER_FIELDS.map(({ key, label, step, integer }) => (
          <label key={key} className="grid grid-cols-[180px_1fr] items-center gap-2">
            <span className="text-sm text-zinc-300">{label}</span>
            <input
              className={FIELD}
              type="number"
              inputMode={integer ? "numeric" : "decimal"}
              min={MUTATION_LIMITS[key].min}
              max={MUTATION_LIMITS[key].max}
              step={step}
              value={drafts[key]}
              onChange={(e) => setDrafts((prev) => ({ ...prev, [key]: e.target.value }))}
              onBlur={() => commitNumber(key, integer)}
            />
          </label>
        ))}
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
