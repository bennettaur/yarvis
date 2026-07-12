import { useEffect, useState } from "react";
import { type Alarm, acknowledgeAlarm, snoozeAlarm } from "../lib/alarms";
import { openExternal } from "../lib/url";

/** Full-screen takeover shown when an alarm fires. */
export default function AlarmOverlay({ alarm, onDone }: { alarm: Alarm; onDone: () => void }) {
  const [secondsPast, setSecondsPast] = useState(
    Math.max(0, Math.floor((Date.now() - alarm.fireAtMs) / 1000)),
  );

  useEffect(() => {
    const t = setInterval(
      () => setSecondsPast(Math.max(0, Math.floor((Date.now() - alarm.fireAtMs) / 1000))),
      1000,
    );
    return () => clearInterval(t);
  }, [alarm.fireAtMs]);

  const escalated = secondsPast >= 60;

  return (
    <div
      className={`fixed inset-0 z-50 flex flex-col items-center justify-center gap-8 ${
        escalated ? "animate-pulse bg-red-950" : "bg-zinc-950"
      }`}
    >
      <div className="text-sm uppercase tracking-[0.3em] text-zinc-400">Alarm</div>
      <div className="max-w-2xl px-8 text-center text-5xl font-semibold text-zinc-50">
        {alarm.label}
      </div>
      {escalated && (
        <div className="text-red-300">Overdue by {secondsPast}s — please acknowledge</div>
      )}
      <div className="flex gap-4">
        {alarm.meetLink && (
          <button
            onClick={async () => {
              openExternal(alarm.meetLink);
              await acknowledgeAlarm(alarm.id);
              onDone();
            }}
            className="rounded-lg bg-emerald-600 px-8 py-3 text-lg font-medium hover:bg-emerald-500"
          >
            Join meeting
          </button>
        )}
        <button
          onClick={async () => {
            await acknowledgeAlarm(alarm.id);
            onDone();
          }}
          className="rounded-lg bg-indigo-600 px-8 py-3 text-lg font-medium hover:bg-indigo-500"
        >
          Acknowledge
        </button>
        <button
          onClick={async () => {
            await snoozeAlarm(alarm.id, 5);
            onDone();
          }}
          className="rounded-lg border border-zinc-600 px-8 py-3 text-lg text-zinc-200 hover:bg-zinc-800"
        >
          Snooze 5 min
        </button>
      </div>
    </div>
  );
}
