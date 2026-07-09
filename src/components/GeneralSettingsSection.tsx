import { useEffect, useState } from "react";
import { getSettings, updateSettings } from "../lib/settings";

export default function GeneralSettingsSection() {
  const [claudeCommand, setClaudeCommand] = useState("claude");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void getSettings()
      .then((s) => setClaudeCommand(s.claudeCommand))
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ claudeCommand });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <div>
        <h3 className="text-sm font-medium text-zinc-200">General Settings</h3>
        <p className="text-xs text-zinc-500">Configure global application behavior and defaults.</p>
      </div>

      <div className="space-y-3 rounded-lg border border-zinc-800 p-4">
        <label className="block space-y-1">
          <span className="text-xs font-medium uppercase tracking-wide text-zinc-400">
            Claude Code Command
          </span>
          <input
            value={claudeCommand}
            onChange={(e) => setClaudeCommand(e.target.value)}
            placeholder="claude"
            className="w-full rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
          <p className="text-[10px] text-zinc-500">
            The base command used to launch Claude Code sessions (e.g. "claude" or "bunx
            @anthropic-ai/claude-code").
          </p>
        </label>

        {error && <p className="text-xs text-red-400">{error}</p>}

        <div className="flex justify-end">
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving}
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-medium hover:bg-indigo-500 disabled:opacity-50"
          >
            {saving ? "Saving..." : "Save changes"}
          </button>
        </div>
      </div>
    </section>
  );
}
