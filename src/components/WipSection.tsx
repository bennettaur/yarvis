import { useEffect, useState } from "react";
import { getWipConfig, saveWipConfig, type WipConfig, type WipSourcesConfig } from "../lib/wip";

/** The toggleable sources, in display order, with human labels. */
const SOURCE_FIELDS: { key: keyof WipSourcesConfig; label: string; hint: string }[] = [
  { key: "myPrs", label: "My open PRs", hint: "Every open PR you authored (can be noisy)" },
  { key: "starredPrs", label: "Starred PRs", hint: "PRs you've starred" },
  { key: "issues", label: "Issues", hint: "Issues you've started work on, plus starred issues" },
  { key: "tasks", label: "Today's tasks", hint: "Open tasks due today" },
  { key: "workspaces", label: "Active workspaces", hint: "Workspaces currently in use" },
];

function Toggle({
  checked,
  onChange,
  label,
  hint,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
  hint: string;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 py-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 h-4 w-4 accent-indigo-500"
      />
      <span>
        <span className="block text-sm text-zinc-100">{label}</span>
        <span className="block text-xs text-zinc-500">{hint}</span>
      </span>
    </label>
  );
}

/**
 * Configures the work-in-progress roll-up shown in the attention panel: which
 * sources are included, and the GitHub issue labels that drive the "labeled
 * issues" source (open issues assigned to you, across issue-tracked repos,
 * carrying any of these labels). Persisted to the sidecar DB via /api/wip/config.
 */
export default function WipSection() {
  const [config, setConfig] = useState<WipConfig | null>(null);
  const [labelInput, setLabelInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState(false);

  useEffect(() => {
    getWipConfig()
      .then(setConfig)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  if (error && !config) {
    return <p className="text-sm text-red-400">Couldn't load config: {error}</p>;
  }
  if (!config) return <p className="text-sm text-zinc-500">Loading…</p>;

  const setSource = (key: keyof WipSourcesConfig, value: boolean) => {
    setSavedAt(false);
    setConfig({ ...config, sources: { ...config.sources, [key]: value } });
  };

  const addLabel = () => {
    const label = labelInput.trim();
    if (!label || config.issueLabels.includes(label)) {
      setLabelInput("");
      return;
    }
    setSavedAt(false);
    setConfig({ ...config, issueLabels: [...config.issueLabels, label] });
    setLabelInput("");
  };

  const removeLabel = (label: string) => {
    setSavedAt(false);
    setConfig({ ...config, issueLabels: config.issueLabels.filter((l) => l !== label) });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      setConfig(await saveWipConfig(config));
      setSavedAt(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-5 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <div>
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Sources</h2>
        <p className="mb-2 text-xs text-zinc-500">
          Which streams feed the "In progress" list in the attention panel.
        </p>
        <div className="divide-y divide-zinc-800/70">
          {SOURCE_FIELDS.map((f) => (
            <Toggle
              key={f.key}
              checked={config.sources[f.key]}
              onChange={(v) => setSource(f.key, v)}
              label={f.label}
              hint={f.hint}
            />
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">
          GitHub issue labels
        </h2>
        <p className="mb-2 text-xs text-zinc-500">
          Surfaces open GitHub issues assigned to you carrying any of these labels, across your
          issue-tracked repos. Leave empty to disable.
        </p>
        <div className="mb-2 flex flex-wrap gap-1.5">
          {config.issueLabels.length === 0 && (
            <span className="text-xs text-zinc-600">No labels configured.</span>
          )}
          {config.issueLabels.map((label) => (
            <span
              key={label}
              className="flex items-center gap-1 rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-200"
            >
              {label}
              <button
                type="button"
                aria-label={`Remove ${label}`}
                onClick={() => removeLabel(label)}
                className="text-zinc-500 hover:text-zinc-200"
              >
                ✕
              </button>
            </span>
          ))}
        </div>
        <input
          value={labelInput}
          onChange={(e) => setLabelInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              addLabel();
            }
          }}
          onBlur={addLabel}
          placeholder="Add a label and press Enter (e.g. in-progress)"
          className="w-full max-w-md rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-zinc-500"
        />
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm text-white hover:bg-indigo-500 disabled:opacity-50"
        >
          {saving ? "Saving…" : "Save"}
        </button>
        {savedAt && <span className="text-xs text-emerald-400">Saved</span>}
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </section>
  );
}
