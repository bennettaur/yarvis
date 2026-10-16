import { useCallback, useEffect, useState } from "react";
import { listProviders, type ProviderInfo } from "../lib/chat";
import {
  DEFAULT_DECISION_MODEL_CONFIG,
  type DecisionModelConfig,
  getDecisionModelConfig,
  saveDecisionModelConfig,
} from "../lib/decisionModel";

/**
 * Which model answers yes/no judgements, and auto mode for tool approvals,
 * which is the first thing that asks it. Only models tagged `decision` in the
 * model catalogue are offered.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

export default function DecisionModelSection() {
  const [config, setConfig] = useState<DecisionModelConfig>(DEFAULT_DECISION_MODEL_CONFIG);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [saved, catalog] = await Promise.all([
        getDecisionModelConfig(),
        listProviders("decision"),
      ]);
      setConfig(saved);
      setProviders(catalog.filter((p) => p.models.length > 0));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const save = useCallback(
    async (patch: Partial<DecisionModelConfig>) => {
      const previous = config;
      setConfig((prev) => ({ ...prev, ...patch }));
      try {
        setConfig(await saveDecisionModelConfig(patch));
        setError(null);
      } catch (e) {
        // A value left on screen next to an error would look saved when it wasn't.
        setConfig(previous);
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [config],
  );

  const selection = config.model;
  const modelsFor = (providerId: string) =>
    providers.find((p) => p.id === providerId)?.models ?? [];

  return (
    <section>
      <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Decision model
      </h2>
      <p className="mb-3 text-sm text-zinc-500">
        A model that answers yes/no judgements. Tag a model with{" "}
        <code className="text-zinc-400">decision</code> in the model catalogue to offer it here.
      </p>

      <div className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-3">
        <div className="grid grid-cols-2 gap-2">
          <select
            aria-label="Decision model provider"
            className={FIELD}
            value={selection?.provider ?? ""}
            onChange={(e) => {
              const provider = e.target.value;
              const model = provider ? (modelsFor(provider)[0]?.id ?? "") : "";
              void save({ model: model ? { provider, model } : null });
            }}
          >
            <option value="">None</option>
            {providers.map((p) => (
              <option key={p.id} value={p.id} disabled={!p.available}>
                {p.label}
                {p.available ? "" : " (no key)"}
              </option>
            ))}
          </select>
          <select
            aria-label="Decision model"
            className={FIELD}
            value={selection?.model ?? ""}
            disabled={!selection?.provider}
            onChange={(e) => {
              if (!selection?.provider) return;
              void save({ model: { provider: selection.provider, model: e.target.value } });
            }}
          >
            {modelsFor(selection?.provider ?? "").map((m) => (
              <option key={m.id} value={m.id}>
                {m.id}
              </option>
            ))}
          </select>
        </div>

        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            className="mt-1"
            checked={config.autoApproveTools}
            disabled={!selection}
            onChange={(e) => void save({ autoApproveTools: e.target.checked })}
          />
          <span>
            Auto mode for tool approvals
            <span className="block text-xs text-zinc-600">
              Before asking you to approve an MCP tool call, the decision model checks whether it
              matches what you asked for and is neither risky nor destructive. If it is sure, the
              call runs. Otherwise you are asked as usual. Spoken turns always ask.
            </span>
          </span>
        </label>
      </div>

      {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
    </section>
  );
}
