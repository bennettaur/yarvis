import { useCallback, useEffect, useMemo, useState } from "react";
import { getHealth, waitForSidecarReady } from "../lib/api";
import {
  type CustomProvider,
  type CustomProviderApiKind,
  type CustomProviderInput,
  type CustomProviderSecretStatus,
  createCustomProvider,
  deleteAllCustomProviderSecrets,
  deleteCustomProvider,
  deleteCustomProviderSecret,
  listCustomProviderSecretStatus,
  listCustomProviders,
  setCustomProviderSecret,
  updateCustomProvider,
} from "../lib/customProviders";
import { restartSidecar } from "../lib/keychain";

/**
 * Restarts the sidecar and waits for it to come back ready before resolving.
 * Captures the current uptime first so the readiness poll doesn't accept the
 * old process answering during the restart window.
 */
async function restartAndWait(): Promise<void> {
  let priorUptimeMs: number | undefined;
  try {
    priorUptimeMs = (await getHealth()).uptimeMs;
  } catch {
    // If the sidecar is already down, the restart will spawn a fresh one and
    // the readiness poll will pick it up without an uptime baseline.
  }
  await restartSidecar();
  await waitForSidecarReady({ minUptimeMsBefore: priorUptimeMs });
}

import { StatusDot } from "./Dashboard";

interface Draft {
  id?: string;
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: string[];
  headerNames: string[];
}

function blankDraft(): Draft {
  return {
    name: "",
    baseUrl: "",
    apiKind: "openai",
    models: [],
    headerNames: [],
  };
}

function draftFromProvider(p: CustomProvider): Draft {
  return {
    id: p.id,
    name: p.name,
    baseUrl: p.baseUrl,
    apiKind: p.apiKind,
    models: [...p.models],
    headerNames: [...p.headerNames],
  };
}

function toInput(d: Draft): CustomProviderInput {
  return {
    name: d.name.trim(),
    baseUrl: d.baseUrl.trim(),
    apiKind: d.apiKind,
    models: d.models.map((m) => m.trim()).filter(Boolean),
    headerNames: d.headerNames.map((h) => h.trim()).filter(Boolean),
  };
}

/**
 * UI for managing user-defined LLM proxies (e.g. a litellm endpoint).
 * Structure (URL, API protocol, models, header names) lives in Postgres and is
 * managed via the sidecar HTTP API; the API key and header values live in the
 * Keychain via Tauri commands. Saves trigger a sidecar restart so the chat
 * picker reflects new providers and secret changes immediately.
 */
export default function CustomProviderSection() {
  const [providers, setProviders] = useState<CustomProvider[]>([]);
  const [secrets, setSecrets] = useState<Record<string, CustomProviderSecretStatus>>({});
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, statuses] = await Promise.all([
        listCustomProviders(),
        listCustomProviderSecretStatus(),
      ]);
      setProviders(rows);
      setSecrets(Object.fromEntries(statuses.map((s) => [s.providerId, s])));
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const beginNew = useCallback(() => {
    setEditingId("new");
    setDraft(blankDraft());
  }, []);

  const beginEdit = useCallback((p: CustomProvider) => {
    setEditingId(p.id);
    setDraft(draftFromProvider(p));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(blankDraft());
  }, []);

  const saveDraft = useCallback(async () => {
    try {
      const input = toInput(draft);
      if (!input.name || !input.baseUrl) {
        setError("Name and base URL are required.");
        return;
      }
      if (draft.id) {
        await updateCustomProvider(draft.id, input);
      } else {
        await createCustomProvider(input);
      }
      // The sidecar serves the provider list itself, so no restart is needed
      // for the chat picker to see structural changes — but keeping the
      // restart here is harmless and keeps secret-related flows consistent.
      await refresh();
      setEditingId(null);
      setDraft(blankDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draft, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this provider? Stored credentials will be cleared.")) {
        return;
      }
      try {
        await deleteCustomProvider(id);
        await deleteAllCustomProviderSecrets(id);
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const saveSecret = useCallback(
    async (id: string, slot: "apiKey" | `header:${string}`, key: string) => {
      const value = secretInputs[key]?.trim();
      if (!value) return;
      try {
        await setCustomProviderSecret(id, slot, value);
        setSecretInputs((prev) => ({ ...prev, [key]: "" }));
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [secretInputs, refresh],
  );

  const clearSecret = useCallback(
    async (id: string, slot: "apiKey" | `header:${string}`) => {
      try {
        await deleteCustomProviderSecret(id, slot);
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const isEditing = editingId !== null;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Custom providers
        </h2>
        {!isEditing && (
          <button
            onClick={beginNew}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Add provider
          </button>
        )}
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        Point Yarvis at an OpenAI- or Anthropic-shaped proxy (e.g. a litellm endpoint). Structure is
        stored in the database; the API key and header values are stored in the macOS Keychain.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}

      {isEditing && (
        <DraftEditor
          draft={draft}
          setDraft={setDraft}
          onSave={() => void saveDraft()}
          onCancel={cancelEdit}
        />
      )}

      <div className="space-y-5">
        {providers.length === 0 && !isEditing && (
          <p className="text-xs text-zinc-500">No custom providers configured.</p>
        )}
        {providers.map((p) =>
          editingId === p.id ? null : (
            <ProviderCard
              key={p.id}
              provider={p}
              status={secrets[p.id]}
              secretInputs={secretInputs}
              setSecretInputs={setSecretInputs}
              onEdit={() => beginEdit(p)}
              onDelete={() => void remove(p.id)}
              onSaveSecret={(slot, key) => void saveSecret(p.id, slot, key)}
              onClearSecret={(slot) => void clearSecret(p.id, slot)}
            />
          ),
        )}
      </div>
    </section>
  );
}

function DraftEditor({
  draft,
  setDraft,
  onSave,
  onCancel,
}: {
  draft: Draft;
  setDraft: (updater: (prev: Draft) => Draft) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="mb-5 rounded-lg border border-zinc-700 bg-zinc-900 p-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Labeled label="Name">
          <input
            value={draft.name}
            placeholder="litellm proxy"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </Labeled>
        <Labeled label="API protocol">
          <select
            value={draft.apiKind}
            onChange={(e) =>
              setDraft((d) => ({
                ...d,
                apiKind: e.target.value as CustomProviderApiKind,
              }))
            }
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          >
            <option value="openai">OpenAI Responses</option>
            <option value="openai-chat">OpenAI /chat/completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </Labeled>
        <Labeled label="Base URL" full>
          <input
            value={draft.baseUrl}
            placeholder="https://litellm.example.com/v1"
            onChange={(e) => setDraft((d) => ({ ...d, baseUrl: e.target.value }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </Labeled>
      </div>

      <ListEditor
        title="Models"
        placeholder="gpt-4o"
        items={draft.models}
        setItems={(next) => setDraft((d) => ({ ...d, models: next }))}
      />
      <ListEditor
        title="Extra header names"
        placeholder="X-Tenant"
        helper="Values are entered after saving."
        items={draft.headerNames}
        setItems={(next) => setDraft((d) => ({ ...d, headerNames: next }))}
      />

      <div className="mt-4 flex justify-end gap-2">
        <button
          onClick={onCancel}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
        >
          Cancel
        </button>
        <button
          onClick={onSave}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
        >
          Save
        </button>
      </div>
    </div>
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
      <div className="mb-1 flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-zinc-500">{title}</span>
      </div>
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

function ProviderCard({
  provider,
  status,
  secretInputs,
  setSecretInputs,
  onEdit,
  onDelete,
  onSaveSecret,
  onClearSecret,
}: {
  provider: CustomProvider;
  status: CustomProviderSecretStatus | undefined;
  secretInputs: Record<string, string>;
  setSecretInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  onEdit: () => void;
  onDelete: () => void;
  onSaveSecret: (slot: "apiKey" | `header:${string}`, key: string) => void;
  onClearSecret: (slot: "apiKey" | `header:${string}`) => void;
}) {
  const apiKeyInputKey = `${provider.id}:apiKey`;
  const apiKeyPresent = status?.apiKeyPresent ?? false;
  const headerSlots = useMemo(
    () =>
      provider.headerNames.map((name) => ({
        name,
        slot: `header:${name}` as const,
        inputKey: `${provider.id}:header:${name}`,
        present: status?.headers?.[name] ?? false,
      })),
    [provider, status],
  );

  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="text-sm font-medium text-zinc-100">{provider.name}</div>
          <div className="text-xs text-zinc-500">
            {provider.apiKind} · {provider.baseUrl}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onEdit}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Edit
          </button>
          <button
            onClick={onDelete}
            className="rounded-md border border-red-900/60 px-2.5 py-1 text-xs text-red-300 hover:bg-red-950/50"
          >
            Delete
          </button>
        </div>
      </div>

      {provider.models.length > 0 && (
        <div className="mb-3 text-xs text-zinc-400">Models: {provider.models.join(", ")}</div>
      )}

      <SecretRow
        label="API key"
        helper={
          provider.apiKind === "anthropic"
            ? "Sent as the x-api-key header."
            : "Sent as Authorization: Bearer."
        }
        present={apiKeyPresent}
        value={secretInputs[apiKeyInputKey] ?? ""}
        setValue={(v) => setSecretInputs((prev) => ({ ...prev, [apiKeyInputKey]: v }))}
        onSave={() => onSaveSecret("apiKey", apiKeyInputKey)}
        onClear={() => onClearSecret("apiKey")}
      />

      {headerSlots.map((h) => (
        <SecretRow
          key={h.name}
          label={h.name}
          helper="Custom header value."
          present={h.present}
          value={secretInputs[h.inputKey] ?? ""}
          setValue={(v) => setSecretInputs((prev) => ({ ...prev, [h.inputKey]: v }))}
          onSave={() => onSaveSecret(h.slot, h.inputKey)}
          onClear={() => onClearSecret(h.slot)}
        />
      ))}
    </div>
  );
}

function SecretRow({
  label,
  helper,
  present,
  value,
  setValue,
  onSave,
  onClear,
}: {
  label: string;
  helper: string;
  present: boolean;
  value: string;
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
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium hover:bg-indigo-500"
        >
          Save
        </button>
        <button
          onClick={onClear}
          disabled={!present}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800 disabled:opacity-40"
        >
          Clear
        </button>
      </div>
    </div>
  );
}
