import { useCallback, useEffect, useMemo, useState } from "react";
import {
  listProviders,
  type ModelCapability,
  type ModelInfo,
  type ProviderInfo,
} from "../lib/chat";
import {
  deleteProviderModel,
  getModelCatalog,
  type ModelCatalog,
  type ProviderModel,
  resetProviderModels,
  saveProviderModel,
} from "../lib/modelCatalog";

/**
 * Which models each provider offers, and what each one can do.
 *
 * Capability tags are the point: they are what keeps a text-to-speech model out
 * of the chat picker and a Whisper checkpoint out of the "text to speech"
 * field. A provider with no rows here uses the bundled defaults, which is what
 * every provider does until it is edited.
 */

const FIELD =
  "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500";

/** What each tag means, shown as the checkbox's title so the list needs no key. */
const CAPABILITY_HINTS: Record<ModelCapability, string> = {
  chat: "Can answer a chat turn — the model that thinks.",
  stt: "Can turn recorded speech into text.",
  tts: "Can speak text aloud.",
  vision: "Can read images in a prompt.",
  embed: "Can produce embedding vectors.",
};

interface Draft {
  modelId: string;
  capabilities: ModelCapability[];
}

function blankDraft(): Draft {
  return { modelId: "", capabilities: ["chat"] };
}

function Chip({ label }: { label: string }) {
  return (
    <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-zinc-400">
      {label}
    </span>
  );
}

export default function ModelCatalogSection() {
  const [catalog, setCatalog] = useState<ModelCatalog | null>(null);
  const [providers, setProviders] = useState<ProviderInfo[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    try {
      // Any capability lists every provider; only their models are narrowed,
      // and this view reads those from the catalogue instead.
      const [loaded, provs] = await Promise.all([getModelCatalog(), listProviders("chat")]);
      setCatalog(loaded);
      setProviders(provs);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /**
   * Every provider worth showing: the ones the sidecar knows, plus any that
   * only exist as rows (a provider whose key was removed still has a
   * catalogue, and hiding it would make those rows uneditable).
   */
  const providerIds = useMemo(() => {
    const ids = new Set<string>(providers.map((p) => p.id));
    for (const id of Object.keys(catalog?.defaults ?? {})) ids.add(id);
    for (const row of catalog?.models ?? []) ids.add(row.providerId);
    return [...ids];
  }, [providers, catalog]);

  const labelFor = useCallback(
    (id: string) => providers.find((p) => p.id === id)?.label ?? id,
    [providers],
  );

  const rowsFor = useCallback(
    (id: string): ProviderModel[] => (catalog?.models ?? []).filter((m) => m.providerId === id),
    [catalog],
  );

  const run = useCallback(
    async (action: () => Promise<unknown>) => {
      setBusy(true);
      try {
        await action();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [refresh],
  );

  /**
   * Writes the bundled defaults out as rows before the first edit to a provider
   * that has none. Saving a single model would otherwise replace the whole
   * default list with that one model — the edit the user meant would silently
   * delete everything beside it.
   */
  const materializeDefaults = useCallback(
    async (providerId: string, defaults: ModelInfo[]) => {
      if (rowsFor(providerId).length > 0) return;
      let order = 0;
      for (const model of defaults) {
        await saveProviderModel({
          providerId,
          modelId: model.id,
          capabilities: model.capabilities,
          sortOrder: order++,
        });
      }
    },
    [rowsFor],
  );

  const addModel = useCallback(
    (providerId: string, defaults: ModelInfo[]) => {
      const draft = drafts[providerId] ?? blankDraft();
      const modelId = draft.modelId.trim();
      if (!modelId || draft.capabilities.length === 0) return;
      void run(async () => {
        await materializeDefaults(providerId, defaults);
        await saveProviderModel({
          providerId,
          modelId,
          capabilities: draft.capabilities,
          sortOrder: rowsFor(providerId).length + defaults.length,
        });
        setDrafts((prev) => ({ ...prev, [providerId]: blankDraft() }));
      });
    },
    [drafts, materializeDefaults, rowsFor, run],
  );

  const toggleCapability = useCallback((providerId: string, capability: ModelCapability) => {
    setDrafts((prev) => {
      const draft = prev[providerId] ?? blankDraft();
      const has = draft.capabilities.includes(capability);
      return {
        ...prev,
        [providerId]: {
          ...draft,
          capabilities: has
            ? draft.capabilities.filter((c) => c !== capability)
            : [...draft.capabilities, capability],
        },
      };
    });
  }, []);

  const editRow = useCallback(
    (row: ProviderModel, capability: ModelCapability) => {
      const has = row.capabilities.includes(capability);
      const capabilities = has
        ? row.capabilities.filter((c) => c !== capability)
        : [...row.capabilities, capability];
      // A model that can do nothing would be invisible in every picker but
      // still occupy a row; removing it is the honest reading of that edit.
      if (capabilities.length === 0) return;
      void run(() =>
        saveProviderModel({
          providerId: row.providerId,
          modelId: row.modelId,
          capabilities,
          enabled: row.enabled,
          sortOrder: row.sortOrder,
        }),
      );
    },
    [run],
  );

  if (!catalog) {
    return (
      <section className="space-y-3">
        <h2 className="text-sm font-medium text-zinc-200">Models</h2>
        <p className="text-sm text-zinc-500">{error ?? "Loading…"}</p>
      </section>
    );
  }

  return (
    <section className="space-y-5">
      <header className="space-y-1">
        <h2 className="text-sm font-medium text-zinc-200">Models</h2>
        <p className="text-xs text-zinc-500">
          What each provider offers, and what each model can do. A provider uses the built-in list
          until you change it here. Tags decide where a model shows up — only{" "}
          <span className="text-zinc-400">chat</span> models can answer a turn, and only{" "}
          <span className="text-zinc-400">tts</span> models can speak one.
        </p>
      </header>

      {providerIds.map((providerId) => {
        const rows = rowsFor(providerId);
        const defaults = catalog.defaults[providerId] ?? [];
        const customised = rows.length > 0;
        const draft = drafts[providerId] ?? blankDraft();
        const shown: { id: string; capabilities: ModelCapability[]; row?: ProviderModel }[] =
          customised
            ? rows.map((r) => ({ id: r.modelId, capabilities: r.capabilities, row: r }))
            : defaults.map((m) => ({ id: m.id, capabilities: m.capabilities }));

        return (
          <div
            key={providerId}
            className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-4"
          >
            <div className="flex items-center gap-2">
              <h3 className="text-sm text-zinc-200">{labelFor(providerId)}</h3>
              <Chip label={customised ? "customised" : "built-in list"} />
              {customised && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(() => resetProviderModels(providerId))}
                  className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800 disabled:opacity-40"
                >
                  Reset to built-in list
                </button>
              )}
            </div>

            {shown.length === 0 && (
              <p className="text-xs text-zinc-600">No models yet. Add one below.</p>
            )}

            <ul className="space-y-1">
              {shown.map((model) => (
                <li
                  key={model.id}
                  className="flex flex-wrap items-center gap-2 rounded-md bg-zinc-900 px-2 py-1.5"
                >
                  <span className="font-mono text-xs text-zinc-300">{model.id}</span>
                  <div className="ml-auto flex items-center gap-2">
                    {catalog.capabilities.map((capability) => {
                      const on = model.capabilities.includes(capability);
                      // Untagging is only offered on a saved row: toggling a
                      // default would have to write the whole list out first,
                      // which "Add model" already does deliberately.
                      return model.row ? (
                        <label
                          key={capability}
                          title={CAPABILITY_HINTS[capability]}
                          className={`flex items-center gap-1 text-[10px] uppercase tracking-wide ${
                            on ? "text-zinc-300" : "text-zinc-600"
                          }`}
                        >
                          <input
                            type="checkbox"
                            checked={on}
                            disabled={busy}
                            onChange={() => editRow(model.row!, capability)}
                          />
                          {capability}
                        </label>
                      ) : (
                        on && <Chip key={capability} label={capability} />
                      );
                    })}
                    {model.row && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => void run(() => deleteProviderModel(providerId, model.id))}
                        className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800 disabled:opacity-40"
                      >
                        Remove
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            <div className="flex flex-wrap items-center gap-2">
              <input
                value={draft.modelId}
                onChange={(e) =>
                  setDrafts((prev) => ({
                    ...prev,
                    [providerId]: { ...draft, modelId: e.target.value },
                  }))
                }
                placeholder="model id"
                className={`${FIELD} max-w-xs font-mono`}
              />
              {catalog.capabilities.map((capability) => (
                <label
                  key={capability}
                  title={CAPABILITY_HINTS[capability]}
                  className="flex items-center gap-1 text-xs text-zinc-400"
                >
                  <input
                    type="checkbox"
                    checked={draft.capabilities.includes(capability)}
                    onChange={() => toggleCapability(providerId, capability)}
                  />
                  {capability}
                </label>
              ))}
              <button
                type="button"
                disabled={busy || !draft.modelId.trim() || draft.capabilities.length === 0}
                onClick={() => addModel(providerId, defaults)}
                className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800 disabled:opacity-40"
              >
                Add model
              </button>
            </div>

            {!customised && defaults.length > 0 && (
              <p className="text-xs text-zinc-600">
                Adding a model copies this built-in list into your settings, so it stays editable.
              </p>
            )}
          </div>
        );
      })}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </section>
  );
}
