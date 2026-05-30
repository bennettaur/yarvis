import { useCallback, useEffect, useMemo, useState } from "react";
import {
  deleteEmbeddingsSecret,
  getEmbeddingsSecretStatus,
  memDeleteEmbeddingsConfig,
  memEmbeddingsConfig,
  memReembed,
  memSetEmbeddingsConfig,
  setEmbeddingsSecret,
  type EmbedderHealth,
  type EmbeddingsConfig,
  type EmbeddingsSecretSlot,
  type EmbeddingsSecretStatus,
} from "../lib/memory";
import { getHealth, waitForSidecarReady } from "../lib/api";
import { restartSidecar } from "../lib/keychain";
import { StatusDot } from "./Dashboard";

/**
 * Restarts the sidecar and waits for it to come back ready before resolving, so
 * a newly-stored embeddings key is injected into a fresh process. Mirrors the
 * helper in CustomProviderSection.
 */
async function restartAndWait(): Promise<void> {
  let priorUptimeMs: number | undefined;
  try {
    priorUptimeMs = (await getHealth()).uptimeMs;
  } catch {
    // If the sidecar is already down, the restart spawns a fresh one and the
    // readiness poll picks it up without an uptime baseline.
  }
  await restartSidecar();
  await waitForSidecarReady({ minUptimeMsBefore: priorUptimeMs });
}

interface Draft {
  baseUrl: string;
  model: string;
  dimensions: string;
  headerNames: string[];
}

function draftFromConfig(c: EmbeddingsConfig | null): Draft {
  return {
    baseUrl: c?.baseUrl ?? "",
    model: c?.model ?? "",
    dimensions: c ? String(c.dimensions) : "1024",
    headerNames: c ? [...c.headerNames] : [],
  };
}

/**
 * UI for the active embeddings provider: an OpenAI-compatible endpoint (the
 * user's proxy or a local Ollama server). Structure (base URL, model,
 * dimension, header names) lives in Postgres; the API key and header values
 * live in the macOS Keychain via Tauri commands. The dimension must match the
 * model's output (and the memories column); mismatched stored vectors are
 * surfaced as a warning with a re-embed action.
 */
export default function EmbeddingsSection() {
  const [config, setConfig] = useState<EmbeddingsConfig | null>(null);
  const [health, setHealth] = useState<EmbedderHealth | null>(null);
  const [secrets, setSecrets] = useState<EmbeddingsSecretStatus | null>(null);
  const [draft, setDraft] = useState<Draft>(() => draftFromConfig(null));
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [result, secretStatus] = await Promise.all([
        memEmbeddingsConfig(),
        getEmbeddingsSecretStatus(),
      ]);
      setConfig(result.config);
      setHealth(result.health);
      setSecrets(secretStatus);
      setDraft(draftFromConfig(result.config));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveConfig = useCallback(async () => {
    const dimensions = Number(draft.dimensions);
    if (!draft.baseUrl.trim() || !draft.model.trim()) {
      setError("Base URL and model are required.");
      return;
    }
    if (!Number.isInteger(dimensions) || dimensions <= 0) {
      setError("Dimension must be a positive integer.");
      return;
    }
    setBusy("config");
    try {
      await memSetEmbeddingsConfig({
        baseUrl: draft.baseUrl.trim(),
        model: draft.model.trim(),
        apiKind: "openai",
        dimensions,
        headerNames: draft.headerNames.map((h) => h.trim()).filter(Boolean),
      });
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [draft, refresh]);

  const disableProvider = useCallback(async () => {
    if (
      !confirm(
        "Disable the embeddings provider? Yarvis will fall back to Gemini or the offline hash embedder.",
      )
    ) {
      return;
    }
    setBusy("config");
    try {
      await memDeleteEmbeddingsConfig();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const saveSecret = useCallback(
    async (slot: EmbeddingsSecretSlot, inputKey: string) => {
      const value = secretInputs[inputKey]?.trim();
      if (!value) return;
      setBusy("secret");
      try {
        await setEmbeddingsSecret(slot, value);
        setSecretInputs((prev) => ({ ...prev, [inputKey]: "" }));
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [secretInputs, refresh],
  );

  const clearSecret = useCallback(
    async (slot: EmbeddingsSecretSlot) => {
      setBusy("secret");
      try {
        await deleteEmbeddingsSecret(slot);
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [refresh],
  );

  const reembed = useCallback(async () => {
    setBusy("reembed");
    try {
      const { reembedded } = await memReembed();
      await refresh();
      setError(null);
      // A transient confirmation via the banner area would need extra state;
      // the refreshed health banner clearing is the success signal. Log count.
      console.log(`[embeddings] re-embedded ${reembedded} memories`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  }, [refresh]);

  const headerSlots = useMemo(
    () =>
      (config?.headerNames ?? []).map((name) => ({
        name,
        slot: `header:${name}` as EmbeddingsSecretSlot,
        inputKey: `header:${name}`,
        present: secrets?.headers?.[name] ?? false,
      })),
    [config, secrets],
  );

  const active = health?.active;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
        Embeddings provider
      </h2>
      <p className="mb-4 text-xs text-zinc-500">
        Generate memory embeddings through an OpenAI-compatible endpoint — your
        proxy or a local Ollama server (e.g. base URL{" "}
        <code className="text-zinc-400">http://localhost:11434/v1</code>, model{" "}
        <code className="text-zinc-400">mxbai-embed-large</code>). The dimension
        must match the model's output. Without a provider, Yarvis uses Gemini (if
        keyed) or an offline fallback.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {active && (
        <div className="mb-4 text-xs text-zinc-400">
          Active embedder: <span className="text-zinc-200">{active.kind}</span>
          {active.model !== active.kind && (
            <>
              {" · "}
              <span className="text-zinc-200">{active.model}</span>
            </>
          )}{" "}
          · {active.dim} dims
        </div>
      )}

      {health && !health.ok && (
        <div className="mb-4 rounded-lg border border-amber-900/60 bg-amber-950/30 p-3 text-xs text-amber-200">
          <p className="mb-2">
            {health.mismatchedCount} stored{" "}
            {health.mismatchedCount === 1 ? "memory was" : "memories were"}{" "}
            produced by a different embedder. Recall mixes incomparable vectors
            until you re-embed.
          </p>
          <button
            onClick={() => void reembed()}
            disabled={busy !== null}
            className="rounded-md bg-amber-600 px-3 py-1.5 text-sm font-medium text-amber-50 hover:bg-amber-500 disabled:opacity-40"
          >
            {busy === "reembed" ? "Re-embedding…" : "Re-embed all"}
          </button>
        </div>
      )}

      {/* Structural config */}
      <div className="rounded-lg border border-zinc-700 bg-zinc-900 p-4">
        <div className="grid gap-3 sm:grid-cols-2">
          <Labeled label="Base URL" full>
            <input
              value={draft.baseUrl}
              placeholder="http://localhost:11434/v1"
              onChange={(e) =>
                setDraft((d) => ({ ...d, baseUrl: e.target.value }))
              }
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
          <Labeled label="Model">
            <input
              value={draft.model}
              placeholder="mxbai-embed-large"
              onChange={(e) =>
                setDraft((d) => ({ ...d, model: e.target.value }))
              }
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
          <Labeled label="Dimension">
            <input
              value={draft.dimensions}
              inputMode="numeric"
              placeholder="1024"
              onChange={(e) =>
                setDraft((d) => ({ ...d, dimensions: e.target.value }))
              }
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
        </div>

        <ListEditor
          title="Extra header names"
          placeholder="X-Tenant"
          helper="Values are entered below after saving."
          items={draft.headerNames}
          setItems={(next) => setDraft((d) => ({ ...d, headerNames: next }))}
        />

        <div className="mt-4 flex justify-end gap-2">
          {config && (
            <button
              onClick={() => void disableProvider()}
              disabled={busy !== null}
              className="rounded-md border border-red-900/60 px-3 py-1.5 text-sm text-red-300 hover:bg-red-950/50 disabled:opacity-40"
            >
              Disable
            </button>
          )}
          <button
            onClick={() => void saveConfig()}
            disabled={busy !== null}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
          >
            {busy === "config" ? "Saving…" : "Save"}
          </button>
        </div>
      </div>

      {/* Secrets — only meaningful once a provider exists */}
      {config && (
        <div className="mt-5">
          <SecretRow
            label="API key"
            helper="Sent as Authorization: Bearer. Leave unset for a local Ollama server."
            present={secrets?.apiKeyPresent ?? false}
            value={secretInputs["apiKey"] ?? ""}
            disabled={busy !== null}
            setValue={(v) =>
              setSecretInputs((prev) => ({ ...prev, apiKey: v }))
            }
            onSave={() => void saveSecret("apiKey", "apiKey")}
            onClear={() => void clearSecret("apiKey")}
          />
          {headerSlots.map((h) => (
            <SecretRow
              key={h.name}
              label={h.name}
              helper="Custom header value."
              present={h.present}
              value={secretInputs[h.inputKey] ?? ""}
              disabled={busy !== null}
              setValue={(v) =>
                setSecretInputs((prev) => ({ ...prev, [h.inputKey]: v }))
              }
              onSave={() => void saveSecret(h.slot, h.inputKey)}
              onClear={() => void clearSecret(h.slot)}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function Labeled({
  label,
  full,
  children,
}: {
  label: string;
  full?: boolean;
  children: React.ReactNode;
}) {
  return (
    <label className={`block text-xs text-zinc-400 ${full ? "sm:col-span-2" : ""}`}>
      <span className="mb-1 block uppercase tracking-wide">{label}</span>
      {children}
    </label>
  );
}

function ListEditor({
  title,
  placeholder,
  helper,
  items,
  setItems,
}: {
  title: string;
  placeholder: string;
  helper?: string;
  items: string[];
  setItems: (next: string[]) => void;
}) {
  const [pending, setPending] = useState("");
  const addItem = useCallback(() => {
    const v = pending.trim();
    if (!v || items.includes(v)) return;
    setItems([...items, v]);
    setPending("");
  }, [pending, items, setItems]);

  return (
    <div className="mt-4">
      <span className="mb-1 block text-xs font-medium uppercase tracking-wide text-zinc-500">
        {title}
      </span>
      {helper && <p className="mb-2 text-xs text-zinc-500">{helper}</p>}
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <span
            key={item}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs"
          >
            {item}
            <button
              onClick={() => setItems(items.filter((i) => i !== item))}
              className="text-zinc-500 hover:text-zinc-200"
              aria-label={`Remove ${item}`}
            >
              ×
            </button>
          </span>
        ))}
      </div>
      <div className="mt-2 flex gap-2">
        <input
          value={pending}
          placeholder={placeholder}
          onChange={(e) => setPending(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addItem();
            }
          }}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <button
          onClick={addItem}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SecretRow({
  label,
  helper,
  present,
  value,
  disabled,
  setValue,
  onSave,
  onClear,
}: {
  label: string;
  helper: string;
  present: boolean;
  value: string;
  disabled: boolean;
  setValue: (v: string) => void;
  onSave: () => void;
  onClear: () => void;
}) {
  return (
    <div className="mt-3">
      <div className="mb-1 flex items-center justify-between">
        <label className="text-sm font-medium">{label}</label>
        <span className="flex items-center gap-1.5 text-xs text-zinc-400">
          <StatusDot state={present} />
          {present ? "set" : "not set"}
        </span>
      </div>
      <p className="mb-2 text-xs text-zinc-500">{helper}</p>
      <div className="flex gap-2">
        <input
          type="password"
          value={value}
          placeholder={present ? "Enter a new value to replace" : ""}
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <button
          onClick={onSave}
          disabled={disabled}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500 disabled:opacity-40"
        >
          Save
        </button>
        <button
          onClick={onClear}
          disabled={!present || disabled}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
