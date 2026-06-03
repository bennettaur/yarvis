import { useCallback, useEffect, useState } from "react";
import CalendarConnectionGate from "./calendar/CalendarConnectionGate";
import EventAlarmButton from "./calendar/EventAlarmButton";
import { isArmable, useEventAlarms } from "../lib/calendarAlarms";
import { startMs } from "../lib/calendarGrid";
import { openExternal } from "../lib/url";
import { calDisconnect, calEvents, type CalendarEvent } from "../lib/calendar";

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
  const when = event.allDay ? "All day" : ms !== null ? new Date(ms).toLocaleString() : event.start;
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
      <EventAlarmButton event={event} armed={armed} onArm={onArm} />
    </li>
  );
}

/** The agenda view: a flat list of upcoming meetings with per-event alarms. */
function Agenda({ onDisconnect }: { onDisconnect: () => void }) {
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { isArmed, arm } = useEventAlarms();

  useEffect(() => {
    calEvents()
      .then(setEvents)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const armAll = useCallback(async () => {
    for (const event of events.filter(isArmable)) {
      await arm(event);
    }
  }, [events, arm]);

  const disconnect = useCallback(async () => {
    await calDisconnect();
    setEvents([]);
    onDisconnect();
  }, [onDisconnect]);

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
              armed={isArmed(e)}
              onArm={(ev) => void arm(ev)}
            />
          ))}
        </ul>
      )}

      {error && <p className="text-sm text-red-400">{error}</p>}
    </div>
  );
}

export default function CalendarPanel() {
  return (
    <CalendarConnectionGate>
      {({ reload }) => <Agenda onDisconnect={reload} />}
    </CalendarConnectionGate>
  );
}
