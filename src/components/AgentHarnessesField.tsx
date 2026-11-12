import { useCallback, useEffect, useState } from "react";
import {
  type AgentHarness,
  BUILTIN_HARNESS_ID,
  getSettings,
  type HarnessKind,
  type HarnessSecretStatus,
  listAgentHarnessSecretStatus,
  type Settings,
  setAgentHarnesses,
  setAgentHarnessSecret,
} from "../lib/settings";

/** What a new harness of each kind starts with. */
const PRESETS: Record<HarnessKind, { label: string; command: string }> = {
  "claude-code": { label: "Claude Code", command: "claude --permission-mode auto" },
  pi: { label: "Pi", command: "pi" },
  opencode: { label: "OpenCode", command: "opencode" },
  custom: { label: "Custom command", command: "" },
};

const KINDS = Object.keys(PRESETS) as HarnessKind[];

/** A harness as edited: env and secret names as text, so a half-typed line
 *  doesn't get dropped before the user finishes it. */
interface Draft {
  /** Client-only React key. Rows can't be keyed by id, which is editable, or by
   *  index, which hands a removed row's half-typed secret to the row below. */
  rowKey: number;
  /** The id this row was saved under, or null for a row not saved yet. A saved
   *  id can't be edited: its secret values are stored under it, and a save
   *  would treat the renamed harness as a removed one and clear them. */
  savedId: string | null;
  id: string;
  name: string;
  kind: HarnessKind;
  command: string;
  promptArgs: string;
  envText: string;
  secretEnvText: string;
  assistantMayUse: boolean;
}

let nextRowKey = 0;

/** `rowKey` carries a saved row's key over a save, so its React subtree (and
 *  any secret value typed but not yet set) survives. */
const toDraft = (h: AgentHarness, rowKey: number = nextRowKey++): Draft => ({
  rowKey,
  savedId: h.id,
  id: h.id,
  name: h.name,
  kind: h.kind,
  command: h.command,
  promptArgs: h.promptArgs ?? "",
  envText: Object.entries(h.env ?? {})
    .map(([k, v]) => `${k}=${v}`)
    .join("\n"),
  secretEnvText: (h.secretEnv ?? []).join(" "),
  assistantMayUse: h.assistantMayUse === true,
});

/** Parses `KEY=value` lines. A line without `=` is kept as a key with an empty
 *  value, so the core reports the bad name instead of it vanishing. */
export const parseEnv = (text: string): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) env[trimmed] = "";
    else env[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1);
  }
  return env;
};

export const fromDraft = (d: Draft): AgentHarness => ({
  id: d.id.trim(),
  name: d.name.trim(),
  kind: d.kind,
  command: d.command.trim(),
  promptArgs: d.promptArgs.trim() || null,
  env: parseEnv(d.envText),
  secretEnv: d.secretEnvText.split(/[\s,]+/).filter(Boolean),
  assistantMayUse: d.assistantMayUse,
});

/** An id derived from a name, made unique against the ids already taken. */
export const idFor = (name: string, taken: string[]): string => {
  const base =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 32) || "harness";
  let id = base;
  for (let n = 2; taken.includes(id) || id === BUILTIN_HARNESS_ID; n++) id = `${base}-${n}`;
  return id;
};

const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * The agent harnesses a workspace session can run besides the built-in agent,
 * and which one is the default. Saves the list as a whole; secret variable
 * values save one at a time, straight to the secret store, and only for a
 * harness already saved with that variable declared.
 */
export default function AgentHarnessesField({
  settings,
  onSaved,
}: {
  settings: Settings;
  onSaved: (next: Settings) => void;
}) {
  const stored = settings.agentHarnesses ?? [];
  const [drafts, setDrafts] = useState<Draft[]>(() => stored.map((h) => toDraft(h)));
  const [defaultId, setDefaultId] = useState(settings.defaultAgentHarness ?? BUILTIN_HARNESS_ID);
  const [secrets, setSecrets] = useState<HarnessSecretStatus[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const refreshSecrets = useCallback(() => {
    listAgentHarnessSecretStatus()
      .then((statuses) => setSecrets(statuses ?? []))
      .catch((e) => setError(`Could not read the harness secrets: ${errorText(e)}`));
  }, []);

  useEffect(() => refreshSecrets(), [refreshSecrets]);

  const update = useCallback(
    (index: number, patch: Partial<Draft>) => {
      // The default follows its harness through an id edit, or Save would send
      // an id that no longer exists.
      const renamed = drafts[index];
      if (patch.id !== undefined && renamed && renamed.id === defaultId) setDefaultId(patch.id);
      setDrafts((current) => current.map((d, i) => (i === index ? { ...d, ...patch } : d)));
      setNotice(null);
      setError(null);
    },
    [defaultId, drafts],
  );

  const add = useCallback((kind: HarnessKind) => {
    setDrafts((current) => {
      const name = PRESETS[kind].label;
      return [
        ...current,
        {
          rowKey: nextRowKey++,
          savedId: null,
          id: idFor(
            name,
            current.map((d) => d.id),
          ),
          name,
          kind,
          command: PRESETS[kind].command,
          promptArgs: "",
          envText: "",
          secretEnvText: "",
          assistantMayUse: false,
        },
      ];
    });
    setNotice(null);
  }, []);

  const remove = useCallback(
    (index: number) => {
      if (drafts[index]?.id === defaultId) setDefaultId(BUILTIN_HARNESS_ID);
      setDrafts((current) => current.filter((_, i) => i !== index));
      setNotice(null);
    },
    [defaultId, drafts],
  );

  const save = useCallback(async () => {
    setError(null);
    setNotice(null);
    setBusy(true);
    try {
      const next = await setAgentHarnesses(drafts.map(fromDraft), defaultId);
      onSaved(next);
      const keyFor = new Map(drafts.map((d) => [d.id.trim(), d.rowKey]));
      setDrafts((next.agentHarnesses ?? []).map((h) => toDraft(h, keyFor.get(h.id))));
      setDefaultId(next.defaultAgentHarness ?? BUILTIN_HARNESS_ID);
      refreshSecrets();
      setNotice("Saved. Applies to the next agent session started.");
    } catch (e) {
      setError(errorText(e));
      // A save can land and then fail clearing removed secrets, so what is
      // stored may already have changed: read it back rather than assume.
      getSettings()
        .then(onSaved)
        .catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }, [defaultId, drafts, onSaved, refreshSecrets]);

  const builtinName = settings.agentName ?? settings.defaultAgentName;

  return (
    <div className="mt-5">
      <h3 className="mb-1 text-xs uppercase tracking-wide text-zinc-400">Agent harnesses</h3>
      <p className="mb-3 text-xs text-zinc-500">
        Other agents a workspace session can run, such as Pi, OpenCode, a sandbox command, or a
        second Claude Code pointed at another provider through its environment. Pick one when
        starting a session, or ask the assistant to use it. Only Claude Code harnesses can resume
        after a restart or take Remote Control. In prompt arguments, <code>{"{prompt}"}</code> marks
        where an instruction goes; it is quoted for you, so don't add quotes around it.
      </p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-3 text-sm text-emerald-400">{notice}</p>}

      <label className="mb-3 block text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Default</span>
        <select
          value={defaultId}
          onChange={(e) => {
            setDefaultId(e.target.value);
            setNotice(null);
          }}
          className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
        >
          <option value={BUILTIN_HARNESS_ID}>{builtinName} (built-in)</option>
          {drafts.map((d) => (
            <option key={d.rowKey} value={d.id}>
              {d.name || d.id}
            </option>
          ))}
        </select>
      </label>

      {drafts.map((d, i) => {
        const saved = d.savedId === null ? undefined : stored.find((h) => h.id === d.savedId);
        return (
          <HarnessRow
            key={d.rowKey}
            draft={d}
            savedSecretEnv={saved?.secretEnv ?? []}
            secrets={secrets.filter((s) => s.harnessId === d.savedId)}
            onChange={(patch) => update(i, patch)}
            onRemove={() => remove(i)}
            onSecretsChanged={refreshSecrets}
          />
        );
      })}

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs text-zinc-500">Add:</span>
        {KINDS.map((kind) => (
          <button
            key={kind}
            type="button"
            onClick={() => add(kind)}
            className="rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-300 hover:bg-zinc-800"
          >
            {PRESETS[kind].label}
          </button>
        ))}
        <button
          type="button"
          onClick={save}
          disabled={busy}
          className="ml-auto rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
        >
          {busy ? "Saving…" : "Save harnesses"}
        </button>
      </div>
    </div>
  );
}

function HarnessRow({
  draft,
  savedSecretEnv,
  secrets,
  onChange,
  onRemove,
  onSecretsChanged,
}: {
  draft: Draft;
  /** Secret variable names as last saved; only these can be given a value. */
  savedSecretEnv: string[];
  secrets: HarnessSecretStatus[];
  onChange: (patch: Partial<Draft>) => void;
  onRemove: () => void;
  onSecretsChanged: () => void;
}) {
  const savedId = draft.savedId;
  const inputClass =
    "w-full rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500";
  return (
    <div className="mb-3 rounded-lg border border-zinc-800 p-3">
      <div className="flex flex-wrap items-start gap-2">
        <label className="w-36 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Name</span>
          <input
            type="text"
            value={draft.name}
            onChange={(e) => onChange({ name: e.target.value })}
            className={inputClass}
          />
        </label>
        <label className="w-32 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Id</span>
          <input
            type="text"
            value={draft.id}
            readOnly={draft.savedId !== null}
            title={draft.savedId !== null ? "A saved harness's id can't change" : undefined}
            onChange={(e) => onChange({ id: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Kind</span>
          <select
            value={draft.kind}
            onChange={(e) => onChange({ kind: e.target.value as HarnessKind })}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm"
          >
            {KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {PRESETS[kind].label}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          onClick={onRemove}
          className="mt-5 ml-auto rounded-md border border-zinc-700 px-2 py-0.5 text-xs text-zinc-400 hover:bg-zinc-800"
        >
          Remove
        </button>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="min-w-64 flex-1 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Command</span>
          <input
            type="text"
            value={draft.command}
            onChange={(e) => onChange({ command: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="w-56 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Prompt arguments</span>
          <input
            type="text"
            value={draft.promptArgs}
            placeholder={draft.kind === "opencode" ? "--prompt {prompt}" : "{prompt}"}
            onChange={(e) => onChange({ promptArgs: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        <label className="min-w-64 flex-1 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">
            Environment (KEY=value per line, not shell-expanded)
          </span>
          <textarea
            value={draft.envText}
            rows={2}
            placeholder="CLAUDE_CODE_USE_BEDROCK=1"
            onChange={(e) => onChange({ envText: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
        <label className="w-56 text-xs text-zinc-400">
          <span className="mb-1 block uppercase tracking-wide">Secret variables</span>
          <input
            type="text"
            value={draft.secretEnvText}
            placeholder="ANTHROPIC_API_KEY"
            onChange={(e) => onChange({ secretEnvText: e.target.value })}
            className={`${inputClass} font-mono`}
          />
        </label>
      </div>
      <label className="mt-2 flex items-center gap-2 text-xs text-zinc-400">
        <input
          type="checkbox"
          checked={draft.assistantMayUse}
          onChange={(e) => onChange({ assistantMayUse: e.target.checked })}
        />
        The assistant may start this harness when asked (always true for the default)
      </label>
      {savedSecretEnv.length > 0 && savedId !== null && (
        <p className="mt-2 text-xs text-amber-400">
          Secret values are set in the session's shell, so every command the agent runs can read
          them.
        </p>
      )}
      {savedId !== null &&
        savedSecretEnv.map((key) => (
          <SecretValue
            key={key}
            harnessId={savedId}
            name={key}
            present={secrets.some((s) => s.key === key && s.present)}
            onChanged={onSecretsChanged}
          />
        ))}
    </div>
  );
}

/** One secret variable's value: write-only, like every other secret field. */
function SecretValue({
  harnessId,
  name,
  present,
  onChanged,
}: {
  harnessId: string;
  name: string;
  present: boolean;
  onChanged: () => void;
}) {
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const write = useCallback(
    async (next: string | null) => {
      setBusy(true);
      setError(null);
      try {
        await setAgentHarnessSecret(harnessId, name, next);
        setValue("");
        onChanged();
      } catch (e) {
        setError(errorText(e));
      } finally {
        setBusy(false);
      }
    },
    [harnessId, name, onChanged],
  );

  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-zinc-400">
      <span className="w-48 truncate font-mono">{name}</span>
      <input
        type="password"
        value={value}
        placeholder={present ? "stored" : "not set"}
        onChange={(e) => setValue(e.target.value)}
        className="w-56 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
      />
      <button
        type="button"
        disabled={busy || !value}
        onClick={() => void write(value)}
        className="rounded-md border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-50"
      >
        Set
      </button>
      {present && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void write(null)}
          className="rounded-md border border-zinc-700 px-2 py-0.5 hover:bg-zinc-800 disabled:opacity-50"
        >
          Clear
        </button>
      )}
      {error && <span className="text-red-400">{error}</span>}
    </div>
  );
}
