import { useState } from "react";
import type { RoutinesResponse } from "../../lib/headsDown";
import { formatRelativeTime } from "../../lib/time";

/** `everyMinutes` back in the `30m`/`3h`/`1d` form the file was written in. */
function cadence(minutes: number): string {
  if (minutes % (24 * 60) === 0) return `every ${minutes / (24 * 60)}d`;
  if (minutes % 60 === 0) return `every ${minutes / 60}h`;
  return `every ${minutes}m`;
}

/**
 * The routines passes take on, read-only: they are markdown files, so the list
 * names the folder to add one in and shows any file that failed to load.
 */
export default function RoutineList({
  data,
  onReload,
}: {
  data: RoutinesResponse | null;
  onReload: () => Promise<void>;
}) {
  const [reloading, setReloading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    setReloading(true);
    setError(null);
    try {
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setReloading(false);
    }
  };

  if (!data) return <p className="text-xs text-zinc-500">Loading…</p>;

  return (
    <div className="space-y-2">
      <ul className="space-y-2">
        {data.routines.map((r) => (
          <li key={r.name} className={`text-xs ${r.enabled ? "" : "opacity-50"}`}>
            <div className="flex items-baseline justify-between gap-2">
              <span className="font-mono text-zinc-200">
                {r.name}
                {r.source === "user" && (
                  <span className="ml-1 font-sans text-zinc-500">(yours)</span>
                )}
              </span>
              <span className="shrink-0 text-zinc-500">
                {r.enabled
                  ? `${cadence(r.everyMinutes)}${r.workingHoursOnly ? ", working hours" : ""}`
                  : "off"}
              </span>
            </div>
            <p className="text-zinc-400">{r.description}</p>
            {r.enabled && (
              <p className="text-zinc-500">
                {r.lastDoneAt ? `Last done ${formatRelativeTime(r.lastDoneAt)}` : "Not done yet"}
              </p>
            )}
          </li>
        ))}
      </ul>
      {data.problems.length > 0 && (
        <ul className="space-y-1">
          {data.problems.map((p) => (
            <li key={p.path} className="break-words text-xs text-amber-400">
              {p.message}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-zinc-500">
        Add your own as markdown files in <span className="font-mono">{data.userDir}</span>. A file
        with the same name as one above replaces it.
      </p>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={reloading}
          onClick={() => void reload()}
          className="text-sm text-zinc-400 hover:text-zinc-200 disabled:opacity-50"
        >
          Reload files
        </button>
        {error && <span className="text-xs text-red-400">{error}</span>}
      </div>
    </div>
  );
}
