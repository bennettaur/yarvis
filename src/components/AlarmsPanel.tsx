import { useCallback, useMemo, useState } from "react";
import {
  acknowledgeAlarm,
  cancelAlarm,
  createAlarm,
  snoozeAlarm,
  useAlarms,
  useRingingAlarms,
} from "../lib/alarmStore";
import { recordEvent } from "../lib/events";

function localInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(
    d.getHours(),
  )}:${pad(d.getMinutes())}`;
}

export default function AlarmsPanel() {
  const alarms = useAlarms();
  const ringing = useRingingAlarms();
  const [label, setLabel] = useState("");
  const [when, setWhen] = useState(() => localInputValue(new Date(Date.now() + 5 * 60_000)));
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<unknown>) => {
    try {
      await action();
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const add = useCallback(async () => {
    const trimmed = label.trim();
    if (!trimmed || !when) return;
    const fireAtMs = new Date(when).getTime();
    await run(() => createAlarm(trimmed, fireAtMs));
    // Record the deliberate creation (not the quick-test or calendar arming).
    void recordEvent(
      "alarm.created",
      { label: trimmed, fireAt: new Date(fireAtMs).toISOString() },
      "alarms",
    );
    setLabel("");
  }, [label, when, run]);

  const quickTest = useCallback(
    () => run(() => createAlarm(label.trim() || "Test alarm", Date.now() + 5000)),
    [label, run],
  );

  const scheduled = useMemo(
    () => alarms.filter((a) => a.status === "scheduled").sort((a, b) => a.fireAtMs - b.fireAtMs),
    [alarms],
  );

  return (
    <div className="space-y-6">
      <section className="space-y-3 rounded-xl border border-zinc-800 bg-zinc-900/50 p-5">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">New alarm</h2>
        <div className="flex flex-wrap gap-2">
          <input
            value={label}
            placeholder="Label (e.g. Standup)"
            onChange={(e) => setLabel(e.target.value)}
            className="flex-1 rounded-md border border-zinc-700 bg-zinc-800 px-3 py-1.5 text-sm outline-none focus:border-zinc-500"
          />
          <input
            type="datetime-local"
            value={when}
            onChange={(e) => setWhen(e.target.value)}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1.5 text-sm"
          />
          <button
            onClick={() => void add()}
            className="rounded-md bg-indigo-600 px-4 py-1.5 text-sm font-medium hover:bg-indigo-500"
          >
            Set
          </button>
          <button
            onClick={() => void quickTest()}
            className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:bg-zinc-800"
            title="Fire a test alarm in 5 seconds"
          >
            Test in 5s
          </button>
        </div>
      </section>

      {/* Alarms that fired and nobody dealt with. Several alarms set for the
          same time all fire together and the takeover only shows one at a
          time, so this is where the rest stay reachable. */}
      {ringing.length > 0 && (
        <section>
          <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-red-400">
            Going off now ({ringing.length})
          </h2>
          <ul className="divide-y divide-red-900/50 rounded-xl border border-red-900/60 bg-red-950/30">
            {ringing.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-red-500" />
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm text-zinc-100">{a.label}</div>
                  <div className="text-xs text-zinc-500">
                    {new Date(a.fireAtMs).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => void run(() => snoozeAlarm(a.id, 5))}
                  className="rounded-md border border-zinc-700 px-3 py-1 text-sm text-zinc-300 hover:bg-zinc-800"
                >
                  Snooze 5 min
                </button>
                <button
                  onClick={() => void run(() => acknowledgeAlarm(a.id))}
                  className="rounded-md bg-indigo-600 px-3 py-1 text-sm font-medium hover:bg-indigo-500"
                >
                  Dismiss
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section>
        <h2 className="mb-2 text-sm font-medium uppercase tracking-wide text-zinc-500">
          Upcoming ({scheduled.length})
        </h2>
        {scheduled.length === 0 ? (
          <p className="text-sm text-zinc-600">No alarms set.</p>
        ) : (
          <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
            {scheduled.map((a) => (
              <li key={a.id} className="flex items-center gap-3 px-4 py-3">
                <div className="flex-1">
                  <div className="text-sm text-zinc-100">{a.label}</div>
                  <div className="text-xs text-zinc-500">
                    {new Date(a.fireAtMs).toLocaleString()}
                  </div>
                </div>
                <button
                  onClick={() => void run(() => cancelAlarm(a.id))}
                  className="text-sm text-zinc-500 hover:text-red-400"
                >
                  Cancel
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
