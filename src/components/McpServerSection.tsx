import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createMcpServer,
  deleteAllMcpSecrets,
  deleteMcpSecret,
  deleteMcpServer,
  listMcpSecretStatus,
  listMcpServers,
  type McpSecretSlot,
  type McpSecretStatus,
  type McpServer,
  type McpServerInput,
  type McpTransport,
  type RefreshResult,
  refreshMcpServer,
  setMcpSecret,
  updateMcpServer,
} from "../lib/mcp";
import { restartAndWait } from "../lib/restart";
import { StatusDot } from "./Dashboard";
import { MaskedInput } from "./MaskedInput";

interface Draft {
  id?: string;
  name: string;
  transport: McpTransport;
  url: string;
  command: string;
  args: string[];
  headerNames: string[];
}

function blankDraft(): Draft {
  return { name: "", transport: "http", url: "", command: "", args: [], headerNames: [] };
}

function draftFromServer(s: McpServer): Draft {
  return {
    id: s.id,
    name: s.name,
    transport: s.transport,
    url: s.url ?? "",
    command: s.command ?? "",
    args: [...s.args],
    headerNames: [...s.headerNames],
  };
}

function toInput(d: Draft): McpServerInput {
  return {
    name: d.name.trim(),
    transport: d.transport,
    url: d.transport === "http" ? d.url.trim() : null,
    command: d.transport === "stdio" ? d.command.trim() : null,
    args: d.transport === "stdio" ? d.args.map((a) => a.trim()).filter(Boolean) : [],
    headerNames: d.transport === "http" ? d.headerNames.map((h) => h.trim()).filter(Boolean) : [],
  };
}

/**
 * UI for managing connected MCP servers. Structure (transport, url/command,
 * args, header names) lives in Postgres via the sidecar HTTP API; HTTP auth
 * header values and stdio env-var values live in the macOS Keychain via Tauri
 * commands. Secret changes restart the sidecar so they take effect, then a
 * Refresh connects and syncs the server's tools into the registry.
 */
export default function McpServerSection() {
  const [servers, setServers] = useState<McpServer[]>([]);
  const [secrets, setSecrets] = useState<Record<string, McpSecretStatus>>({});
  const [statuses, setStatuses] = useState<Record<string, RefreshResult>>({});
  const [editingId, setEditingId] = useState<string | "new" | null>(null);
  const [draft, setDraft] = useState<Draft>(blankDraft);
  const [secretInputs, setSecretInputs] = useState<Record<string, string>>({});
  const [envNameInputs, setEnvNameInputs] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [rows, secretStatuses] = await Promise.all([listMcpServers(), listMcpSecretStatus()]);
      setServers(rows);
      setSecrets(Object.fromEntries(secretStatuses.map((s) => [s.serverId, s])));
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

  const beginEdit = useCallback((s: McpServer) => {
    setEditingId(s.id);
    setDraft(draftFromServer(s));
  }, []);

  const cancelEdit = useCallback(() => {
    setEditingId(null);
    setDraft(blankDraft());
  }, []);

  const saveDraft = useCallback(async () => {
    try {
      const input = toInput(draft);
      if (!input.name) {
        setError("Name is required.");
        return;
      }
      if (input.transport === "http" && !input.url) {
        setError("HTTP servers need a URL.");
        return;
      }
      if (input.transport === "stdio" && !input.command) {
        setError("Stdio servers need a command.");
        return;
      }
      if (draft.id) await updateMcpServer(draft.id, input);
      else await createMcpServer(input);
      await refresh();
      setEditingId(null);
      setDraft(blankDraft());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [draft, refresh]);

  const remove = useCallback(
    async (id: string) => {
      if (!confirm("Delete this server? Stored credentials and its tools will be cleared.")) return;
      try {
        await deleteMcpServer(id);
        await deleteAllMcpSecrets(id);
        await restartAndWait();
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const toggleEnabled = useCallback(
    async (s: McpServer) => {
      try {
        await updateMcpServer(s.id, { enabled: !s.enabled });
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [refresh],
  );

  const connect = useCallback(async (id: string) => {
    try {
      const result = await refreshMcpServer(id);
      setStatuses((prev) => ({ ...prev, [id]: result }));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const saveSecret = useCallback(
    async (id: string, slot: McpSecretSlot, key: string) => {
      const value = secretInputs[key]?.trim();
      if (!value) return;
      try {
        await setMcpSecret(id, slot, value);
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
    async (id: string, slot: McpSecretSlot) => {
      try {
        await deleteMcpSecret(id, slot);
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
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">MCP servers</h2>
        {!isEditing && (
          <button
            onClick={beginNew}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Add server
          </button>
        )}
      </div>
      <p className="mb-4 text-xs text-zinc-500">
        Connect MCP servers (remote HTTP or local stdio) to give the agent more tools. Structure is
        stored in the database; auth header and env values are stored in the macOS Keychain. After
        setting credentials, use Connect to load the server's tools.
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
        {servers.length === 0 && !isEditing && (
          <p className="text-xs text-zinc-500">No MCP servers configured.</p>
        )}
        {servers.map((s) =>
          editingId === s.id ? null : (
            <ServerCard
              key={s.id}
              server={s}
              status={secrets[s.id]}
              connection={statuses[s.id]}
              secretInputs={secretInputs}
              setSecretInputs={setSecretInputs}
              envNameInput={envNameInputs[s.id] ?? ""}
              setEnvNameInput={(v) => setEnvNameInputs((prev) => ({ ...prev, [s.id]: v }))}
              onEdit={() => beginEdit(s)}
              onDelete={() => void remove(s.id)}
              onToggleEnabled={() => void toggleEnabled(s)}
              onConnect={() => void connect(s.id)}
              onSaveSecret={(slot, key) => void saveSecret(s.id, slot, key)}
              onClearSecret={(slot) => void clearSecret(s.id, slot)}
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
            placeholder="filesystem"
            onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
        </Labeled>
        <Labeled label="Transport">
          <select
            value={draft.transport}
            onChange={(e) => setDraft((d) => ({ ...d, transport: e.target.value as McpTransport }))}
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
          >
            <option value="http">Remote (HTTP / SSE)</option>
            <option value="stdio">Local (stdio subprocess)</option>
          </select>
        </Labeled>
        {draft.transport === "http" ? (
          <Labeled label="URL" full>
            <input
              value={draft.url}
              placeholder="https://mcp.example.com/sse"
              onChange={(e) => setDraft((d) => ({ ...d, url: e.target.value }))}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
        ) : (
          <Labeled label="Command" full>
            <input
              value={draft.command}
              placeholder="npx"
              onChange={(e) => setDraft((d) => ({ ...d, command: e.target.value }))}
              className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
            />
          </Labeled>
        )}
      </div>

      {draft.transport === "http" ? (
        <ListEditor
          title="Auth header names"
          placeholder="Authorization"
          helper="Values are entered after saving."
          items={draft.headerNames}
          setItems={(next) => setDraft((d) => ({ ...d, headerNames: next }))}
        />
      ) : (
        <ListEditor
          title="Command arguments"
          placeholder="-y"
          helper="Secret env vars are added per-server after saving."
          items={draft.args}
          setItems={(next) => setDraft((d) => ({ ...d, args: next }))}
        />
      )}

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
    if (!v) return;
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
        {items.map((item, i) => (
          <span
            key={`${item}:${i}`}
            className="inline-flex items-center gap-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-0.5 text-xs"
          >
            {item}
            <button
              onClick={() => setItems(items.filter((_, j) => j !== i))}
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

function ServerCard({
  server,
  status,
  connection,
  secretInputs,
  setSecretInputs,
  envNameInput,
  setEnvNameInput,
  onEdit,
  onDelete,
  onToggleEnabled,
  onConnect,
  onSaveSecret,
  onClearSecret,
}: {
  server: McpServer;
  status: McpSecretStatus | undefined;
  connection: RefreshResult | undefined;
  secretInputs: Record<string, string>;
  setSecretInputs: (updater: (prev: Record<string, string>) => Record<string, string>) => void;
  envNameInput: string;
  setEnvNameInput: (v: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onToggleEnabled: () => void;
  onConnect: () => void;
  onSaveSecret: (slot: McpSecretSlot, key: string) => void;
  onClearSecret: (slot: McpSecretSlot) => void;
}) {
  const headerSlots = useMemo(
    () =>
      server.headerNames.map((name) => ({
        name,
        slot: `header:${name}` as McpSecretSlot,
        inputKey: `${server.id}:header:${name}`,
        present: status?.headers?.[name] ?? false,
      })),
    [server, status],
  );

  // Env slots come from whatever env values are already stored, since env names
  // aren't part of the structural row. New names can be added inline below.
  const envSlots = useMemo(
    () =>
      Object.keys(status?.env ?? {}).map((name) => ({
        name,
        slot: `env:${name}` as McpSecretSlot,
        inputKey: `${server.id}:env:${name}`,
        present: status?.env?.[name] ?? false,
      })),
    [server.id, status],
  );

  return (
    <div className="rounded-lg border border-zinc-800 p-4">
      <div className="mb-2 flex items-center justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-medium text-zinc-100">
            {server.name}
            {!server.enabled && <span className="text-xs text-zinc-500">(disabled)</span>}
          </div>
          <div className="text-xs text-zinc-500">
            {server.transport === "http"
              ? server.url
              : `${server.command} ${server.args.join(" ")}`}
          </div>
        </div>
        <div className="flex gap-1.5">
          <button
            onClick={onConnect}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            Connect
          </button>
          <button
            onClick={onToggleEnabled}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {server.enabled ? "Disable" : "Enable"}
          </button>
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

      {connection && (
        <div className="mb-3 flex items-center gap-1.5 text-xs text-zinc-400">
          <StatusDot state={connection.connected} />
          {connection.error
            ? `Connection failed: ${connection.error}`
            : `${connection.connected ? "Connected" : "Disconnected"} · ${connection.toolCount} tools`}
        </div>
      )}

      {headerSlots.map((h) => (
        <SecretRow
          key={h.name}
          label={h.name}
          helper="Auth header value."
          present={h.present}
          value={secretInputs[h.inputKey] ?? ""}
          setValue={(v) => setSecretInputs((prev) => ({ ...prev, [h.inputKey]: v }))}
          onSave={() => onSaveSecret(h.slot, h.inputKey)}
          onClear={() => onClearSecret(h.slot)}
        />
      ))}

      {server.transport === "stdio" && (
        <>
          {envSlots.map((e) => (
            <SecretRow
              key={e.name}
              label={e.name}
              helper="Environment variable value."
              present={e.present}
              value={secretInputs[e.inputKey] ?? ""}
              setValue={(v) => setSecretInputs((prev) => ({ ...prev, [e.inputKey]: v }))}
              onSave={() => onSaveSecret(e.slot, e.inputKey)}
              onClear={() => onClearSecret(e.slot)}
            />
          ))}
          <AddEnvSecret
            value={envNameInput}
            setValue={setEnvNameInput}
            onAdd={(name) => {
              const key = `${server.id}:env:${name}`;
              // Seed an empty input row; the user types the value then Saves.
              setSecretInputs((prev) => ({ ...prev, [key]: prev[key] ?? "" }));
              onSaveSecret(`env:${name}` as McpSecretSlot, key);
            }}
          />
        </>
      )}
    </div>
  );
}

function AddEnvSecret({
  value,
  setValue,
  onAdd,
}: {
  value: string;
  setValue: (v: string) => void;
  onAdd: (name: string) => void;
}) {
  return (
    <div className="mt-3 border-t border-zinc-800 pt-3">
      <p className="mb-2 text-xs text-zinc-500">
        Add a secret env var by name, then set its value in the row that appears.
      </p>
      <div className="flex gap-2">
        <input
          value={value}
          placeholder="API_TOKEN"
          onChange={(e) => setValue(e.target.value)}
          className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
        <button
          onClick={() => {
            const name = value.trim();
            if (name) {
              onAdd(name);
              setValue("");
            }
          }}
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
        <MaskedInput
          value={value}
          placeholder={present ? "Enter a new value to replace" : ""}
          onChange={setValue}
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
