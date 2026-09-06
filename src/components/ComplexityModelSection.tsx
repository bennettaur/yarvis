import { useCallback, useEffect, useState } from "react";
import { listProviders, type ProviderInfo } from "../lib/chat";
import {
  COMPLEXITY_TIERS,
  type ComplexityModelConfig,
  type ComplexityTier,
  DEFAULT_COMPLEXITY_MODEL_CONFIG,
  getComplexityModelConfig,
  type ModelSelection,
  saveComplexityModelConfig,
} from "../lib/complexityModels";

/**
 * Which model answers for each complexity tier — the setting internal-use
 * specialists (session summaries, activity consolidation) draw on instead of a
 * model hardcoded into their prompt. A tier left unset falls back to whatever
 * the chat default is, so leaving all three blank changes nothing (see
 * `complexityModels.ts` for why this lives server-side).
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

const TIER_HINTS: Record<ComplexityTier, string> = {
  low: "Cheap, fast calls — a session or activity summary.",
  medium: "A bit more judgment — consolidating memory, scouting work.",
  max: "Whatever actually needs the best model available.",
};

export default function ComplexityModelSection() {
  const [config, setConfig] = useState<ComplexityModelConfig>(DEFAULT_COMPLEXITY_MODEL_CONFIG);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [saved, catalog] = await Promise.all([
        getComplexityModelConfig(),
        listProviders("chat"),
      ]);
      setConfig(saved);
      setProviders(catalog);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (tier: ComplexityTier, selection: ModelSelection | null) => {
      setConfig((prev) => ({ ...prev, [tier]: selection }));
      try {
        setConfig(await saveComplexityModelConfig({ [tier]: selection }));
        setError(null);
      } catch (e) {
        // Revert the optimistic update: a selection left on screen next to an
        // error would otherwise look saved when it wasn't.
        setConfig((prev) => ({ ...prev, [tier]: config[tier] }));
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [config],
  );

  const modelsFor = (providerId: string) =>
    providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Complexity tiers
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        The model behind low-, medium- and max-complexity internal work. A specialist opts into a
        tier with <code className="text-zinc-400">complexity:</code> in its definition instead of
        naming a model directly.
      </p>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        {COMPLEXITY_TIERS.map((tier) => {
          const selection = config[tier];
          return (
            <div key={tier} className="grid grid-cols-[100px_1fr_1fr] items-start gap-2">
              <div>
                <p className="text-sm capitalize text-zinc-300">{tier}</p>
                <p className="text-xs text-zinc-600">{TIER_HINTS[tier]}</p>
              </div>
              <select
                className={FIELD}
                value={selection?.provider ?? ""}
                onChange={(e) => {
                  const provider = e.target.value;
                  if (!provider) {
                    void save(tier, null);
                    return;
                  }
                  const model = modelsFor(provider)[0]?.id ?? "";
                  void save(tier, model ? { provider, model } : null);
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
                  void save(tier, { provider: selection.provider, model: e.target.value });
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
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
