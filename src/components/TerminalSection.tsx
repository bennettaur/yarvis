import { useCallback, useEffect, useState } from "react";
import { getSettings, type Settings, setMaxPtySessions } from "../lib/settings";

/**
 * Terminal preferences the Rust core enforces. Currently just the cap on live
 * sessions: each one is a real shell, so the cap trades memory and process
 * count for how many workspaces can stay open at once. Sits beside Repositories
 * because workspaces are what open terminals in bulk.
 */
export default function TerminalSection() {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const apply = useCallback((next: Settings) => {
    setSettings(next);
    setDraft(next.maxPtySessions === null ? "" : String(next.maxPtySessions));
  }, []);

  useEffect(() => {
    getSettings()
      .then(apply)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [apply]);

  const save = useCallback(async () => {
    setError(null);
    setNotice(null);
    // An empty field means "use the default", which the core stores as null.
    const trimmed = draft.trim();
    let value: number | null = null;
    if (trimmed) {
      const parsed = Number(trimmed);
      if (!Number.isInteger(parsed) || parsed < 1) {
        setError("Enter a whole number of 1 or more, or leave it blank for the default.");
        return;
      }
      value = parsed;
    }
    try {
      apply(await setMaxPtySessions(value));
      setNotice("Saved. Applies to the next terminal you open.");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [apply, draft]);

  const defaultCap = settings?.defaultMaxPtySessions;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
      <h2 className="mb-1 text-sm font-medium uppercase tracking-wide text-zinc-500">Terminals</h2>
      <p className="mb-4 text-xs text-zinc-500">
        The most terminal sessions that can be live at once. Opening more fails until one is closed.
        Each session is a real shell, so this trades memory and process count for how many
        workspaces you can keep open. Changes apply to the next terminal opened.
      </p>

      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      {notice && <p className="mb-3 text-sm text-emerald-400">{notice}</p>}

      <label className="block text-xs text-zinc-400">
        <span className="mb-1 block uppercase tracking-wide">Session limit</span>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={1}
            value={draft}
            placeholder={defaultCap === undefined ? "" : String(defaultCap)}
            onChange={(e) => setDraft(e.target.value)}
            className="w-24 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-sm outline-none focus:border-zinc-500"
          />
          <button
            onClick={save}
            disabled={settings === null}
            className="rounded-md border border-zinc-700 px-2.5 py-1 text-xs text-zinc-300 hover:bg-zinc-800 disabled:opacity-50"
          >
            Save
          </button>
          <span className="text-xs text-zinc-500">
            {defaultCap === undefined ? "" : `Blank uses the default of ${defaultCap}.`}
          </span>
        </div>
      </label>
    </section>
  );
}
