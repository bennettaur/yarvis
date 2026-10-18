import { useEffect, useState } from "react";
import {
  type AllowedTool,
  type HeadsDownConfig,
  saveHeadsDownConfig,
  setToolAllowed,
  type WorkingHours,
} from "../../lib/headsDown";

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const DEFAULT_HOURS: WorkingHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };

function NumberField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="flex items-center justify-between gap-3 text-sm text-zinc-300">
      {label}
      <input
        type="number"
        min={1}
        value={value}
        onChange={(e) => {
          // A cleared or partial field isn't a number of minutes; keep the last one.
          const minutes = Number.parseInt(e.target.value, 10);
          if (Number.isFinite(minutes) && minutes >= 1) onChange(minutes);
        }}
        className="w-20 rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-right"
      />
    </label>
  );
}

/**
 * How often heads-down mode looks at the work, and when the user works. The
 * working hours are also when it may tag people, and they are kept per machine.
 */
export default function HeadsDownSettings({
  config,
  allowedTools,
  onSaved,
}: {
  config: HeadsDownConfig;
  /** MCP tools it may call without asking; added from an approval, removed here. */
  allowedTools: AllowedTool[];
  onSaved: () => void;
}) {
  const [draft, setDraft] = useState(config);
  // The hours to go back to when "any time" is unticked.
  const [lastHours, setLastHours] = useState<WorkingHours>(config.workingHours ?? DEFAULT_HOURS);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDraft(config);
    if (config.workingHours) setLastHours(config.workingHours);
  }, [config]);

  const set = <K extends keyof HeadsDownConfig>(key: K, value: HeadsDownConfig[K]) =>
    setDraft((d) => ({ ...d, [key]: value }));
  const hours = draft.workingHours;

  const setHours = (next: WorkingHours) => {
    setLastHours(next);
    set("workingHours", next);
  };

  const toggleDay = (day: number) => {
    if (!hours) return;
    const days = hours.days.includes(day)
      ? hours.days.filter((d) => d !== day)
      : [...hours.days, day].sort();
    setHours({ ...hours, days });
  };

  const removeTool = async (id: string) => {
    setError(null);
    try {
      await setToolAllowed(id, false);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await saveHeadsDownConfig(draft);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <NumberField
        label="Shortest sleep between passes (min)"
        value={draft.minSleepMinutes}
        onChange={(v) => set("minSleepMinutes", v)}
      />
      <NumberField
        label="Longest sleep (min)"
        value={draft.maxSleepMinutes}
        onChange={(v) => set("maxSleepMinutes", v)}
      />
      <NumberField
        label="Sleep when there's little to do (min)"
        value={draft.idleSleepMinutes}
        onChange={(v) => set("idleSleepMinutes", v)}
      />
      <NumberField
        label="You count as away after (min)"
        value={draft.userAwayAfterMinutes}
        onChange={(v) => set("userAwayAfterMinutes", v)}
      />

      <div className="space-y-2 border-t border-zinc-800 pt-3">
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input
            type="checkbox"
            checked={hours === null}
            onChange={(e) => set("workingHours", e.target.checked ? null : lastHours)}
          />
          Any time is fine to tag people
        </label>
        {hours && (
          <>
            <div className="flex flex-wrap gap-1">
              {DAYS.map((name, day) => (
                <button
                  key={name}
                  type="button"
                  aria-pressed={hours.days.includes(day)}
                  onClick={() => toggleDay(day)}
                  className={`rounded px-2 py-0.5 text-xs ${
                    hours.days.includes(day)
                      ? "bg-indigo-600 text-white"
                      : "border border-zinc-700 text-zinc-400"
                  }`}
                >
                  {name}
                </button>
              ))}
            </div>
            <div className="flex items-center gap-2 text-sm text-zinc-300">
              From
              <input
                type="time"
                value={hours.start}
                onChange={(e) => setHours({ ...hours, start: e.target.value })}
                aria-label="Working hours start"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1"
              />
              to
              <input
                type="time"
                value={hours.end}
                onChange={(e) => setHours({ ...hours, end: e.target.value })}
                aria-label="Working hours end"
                className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1"
              />
            </div>
            <p className="text-xs text-zinc-500">
              Outside these hours it sleeps longer, and doesn't tag anyone or bump review requests.
              An end at or before the start runs past midnight.
            </p>
          </>
        )}
      </div>

      <div className="space-y-1 border-t border-zinc-800 pt-3 text-sm text-zinc-300">
        MCP tools it may use without asking
        {allowedTools.length === 0 ? (
          <p className="text-xs text-zinc-500">
            None. Allow one from its approval under Needs you.
          </p>
        ) : (
          <ul className="space-y-1">
            {allowedTools.map((tool) => (
              <li key={tool.id} className="flex items-center justify-between gap-2 text-xs">
                <span className="truncate font-mono text-zinc-300" title={tool.id}>
                  {tool.name}
                </span>
                <button
                  type="button"
                  onClick={() => void removeTool(tool.id)}
                  aria-label={`Stop allowing ${tool.name}`}
                  className="text-zinc-500 hover:text-zinc-200"
                >
                  Remove
                </button>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-zinc-500">
          Auto-approval from the Tool manager is for chats you're watching, so it doesn't apply
          here, and a tool that changes has to be allowed again. Every other MCP tool waits for your
          approval.
        </p>
      </div>

      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={saving}
          onClick={() => void save()}
          className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500 disabled:opacity-50"
        >
          Save
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
