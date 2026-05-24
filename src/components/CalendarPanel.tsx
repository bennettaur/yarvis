import { useCallback, useEffect, useState } from "react";
import { createAlarm } from "../lib/alarms";
import { openExternal } from "../lib/url";
import {
  calAuthUrl,
  calDisconnect,
  calEvents,
  calStatus,
  type CalendarEvent,
  type CalendarStatus,
} from "../lib/calendar";

// Fire the meeting alarm shortly before the start. The alarm system then
// escalates ~60s later (around the meeting start) if it isn't acknowledged.
const LEAD_MINUTES = 1;

function startMs(event: CalendarEvent): number | null {
  const t = Date.parse(event.start);
  return Number.isNaN(t) ? null : t;
}

function isArmable(event: CalendarEvent): boolean {
  if (event.allDay) return false;
  const ms = startMs(event);
  return ms !== null && ms > Date.now();
}

function EventRow({
  event,
  armed,
  onArm,
}: {
  event: CalendarEvent;
  armed: boolean;
  onArm: (event: CalendarEvent) => void;
}) {
  const ms = startMs(event);
  const when = event.allDay
    ? "All day"
    : ms !== null
      ? new Date(ms).toLocaleString()
      : event.start;
  return (
    <li className="flex items-center gap-3 px-4 py-3">
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm text-zinc-100">{event.title}</div>
        <div className="text-xs text-zinc-500">
          {when}
          {event.meetLink && (
            <>
              {" · "}
              <button
                onClick={() => openExternal(event.meetLink)}
                className="text-indigo-400 hover:underline"
              >
                join
              </button>
            </>
          )}
        </div>
      </div>
      {isArmable(event) ? (
        armed ? (
          <span className="text-xs text-emerald-400">alarm set</span>
        ) : (
          <button
            onClick={() => onArm(event)}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Set alarm
          </button>
        )
      ) : null}
    </li>
  );
}

export default function CalendarPanel() {
  const [status, setStatus] = useState<CalendarStatus | null>(null);
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [armed, setArmed] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const s = await calStatus();
      setStatus(s);
      if (s.connected) setEvents(await calEvents());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => {
    void loadStatus();
  }, [loadStatus]);

  const connect = useCallback(async () => {
    try {
      const { url } = await calAuthUrl();
      openExternal(url);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const armEvent = useCallback(async (event: CalendarEvent) => {
    const ms = startMs(event);
    if (ms === null) return;
    const fireAt = ms - LEAD_MINUTES * 60_000;
    await createAlarm(`Meeting: ${event.title}`, fireAt);
    setArmed((prev) => new Set(prev).add(event.id));
  }, []);

  const armAll = useCallback(async () => {
    for (const event of events.filter(isArmable)) {
      await armEvent(event);
    }
  }, [events, armEvent]);

  const disconnect = useCallback(async () => {
    await calDisconnect();
    setEvents([]);
    setArmed(new Set());
    await loadStatus();
  }, [loadStatus]);

  if (!status) {
    return <p className="text-sm text-zinc-500">Loading…</p>;
  }

  if (!status.configured) {
    return (
      <div className="space-y-2 text-sm text-zinc-400">
        <p>
          Google Calendar isn't configured. Add a Google Cloud OAuth client
          (Desktop app) under <b>Settings → Google client id / secret</b> to
          connect your calendar.
        </p>
        <p className="text-xs text-zinc-600">
          The redirect URI to register is{" "}
          <code className="rounded bg-zinc-800 px-1">
            http://127.0.0.1:&lt;sidecar-port&gt;/oauth/google/callback
          </code>{" "}
          (loopback; any port is accepted for Desktop clients).
        </p>
      </div>
    );
  }

  if (!status.connected) {
    return (
      <div className="space-y-3">
        <p className="text-sm text-zinc-400">
          Connect your Google Calendar to see upcoming meetings and arm alarms
          for them.
        </p>
        <button
          onClick={() => void connect()}
          className="rounded-md border border-zinc-700 px-3 py-1.5 text-sm hover:bg-zinc-800"
        >
          Connect Google Calendar
        </button>
        <button
          onClick={() => void loadStatus()}
          className="ml-2 text-sm text-zinc-500 hover:text-zinc-300"
        >
          I've connected — refresh
        </button>
        {error && <p className="text-sm text-red-400">{error}</p>}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <h2 className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Upcoming ({events.length})
        </h2>
        <button
          onClick={() => void armAll()}
          className="ml-auto rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
        >
          Set alarms for all
        </button>
        <button
          onClick={() => void disconnect()}
          className="text-xs text-zinc-500 hover:text-red-400"
        >
          Disconnect
        </button>
      </div>

      {events.length === 0 ? (
        <p className="text-sm text-zinc-600">No upcoming events.</p>
      ) : (
        <ul className="divide-y divide-zinc-800 rounded-xl border border-zinc-800 bg-zinc-900/50">
          {events.map((e) => (
            <EventRow
              key={e.id}
              event={e}
              armed={armed.has(e.id)}
              onArm={(ev) => void armEvent(ev)}
            />
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}
