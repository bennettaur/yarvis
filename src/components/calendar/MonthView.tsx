import { useState } from "react";
import CalendarConnectionGate from "./CalendarConnectionGate";
import EventAlarmButton from "./EventAlarmButton";
import { useNow, useRangeEvents } from "./useRangeEvents";
import { useEventAlarms } from "../../lib/calendarAlarms";
import type { CalendarEvent } from "../../lib/calendar";
import {
  addDays,
  eventsForDay,
  formatMonthLabel,
  formatTime,
  monthGridDays,
  sameDay,
  startMs,
  startOfMonth,
} from "../../lib/calendarGrid";

const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
/** Events listed per day cell before collapsing the rest into "+N more". */
const MAX_PER_CELL = 4;

function EventLine({
  event,
  armed,
  onArm,
}: {
  event: CalendarEvent;
  armed: boolean;
  onArm: (e: CalendarEvent) => void;
}) {
  const ms = startMs(event);
  return (
    <div className="flex items-center gap-1 text-[11px] leading-tight">
      {!event.allDay && ms !== null && (
        <span className="shrink-0 tabular-nums text-zinc-500">
          {formatTime(new Date(ms))}
        </span>
      )}
      <span className="min-w-0 flex-1 truncate text-zinc-200" title={event.title}>
        {event.title}
      </span>
      <EventAlarmButton event={event} armed={armed} onArm={onArm} compact />
    </div>
  );
}

function DayCell({
  day,
  month,
  events,
  now,
  isArmed,
  onArm,
}: {
  day: Date;
  month: Date;
  events: CalendarEvent[];
  now: Date;
  isArmed: (e: CalendarEvent) => boolean;
  onArm: (e: CalendarEvent) => void;
}) {
  const { allDay, timed } = eventsForDay(events, day);
  const dayEvents = [...allDay, ...timed];
  const inMonth = day.getMonth() === month.getMonth();
  const today = sameDay(day, now);
  const shown = dayEvents.slice(0, MAX_PER_CELL);
  const overflow = dayEvents.length - shown.length;

  return (
    <div
      className={`flex min-h-0 flex-col overflow-hidden border-l border-t border-zinc-800 p-1 ${
        inMonth ? "" : "bg-zinc-950/40"
      }`}
    >
      <div
        className={`mb-0.5 text-right text-xs ${
          today
            ? "font-semibold text-indigo-300"
            : inMonth
              ? "text-zinc-400"
              : "text-zinc-600"
        }`}
      >
        {day.getDate()}
      </div>
      <div className="min-h-0 flex-1 space-y-0.5 overflow-hidden">
        {shown.map((e) => (
          <EventLine
            key={e.id}
            event={e}
            armed={isArmed(e)}
            onArm={onArm}
          />
        ))}
        {overflow > 0 && (
          <div className="text-[10px] text-zinc-500">+{overflow} more</div>
        )}
      </div>
    </div>
  );
}

function Month() {
  const [anchor, setAnchor] = useState(() => new Date());
  const now = useNow();
  const month = startOfMonth(anchor);
  const days = monthGridDays(anchor);
  const { events, error, loading } = useRangeEvents(days[0], addDays(days[41], 1));
  const { isArmed, arm } = useEventAlarms();

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <h2 className="text-sm font-medium text-zinc-200">
          {formatMonthLabel(month)}
        </h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setAnchor((d) => startOfMonth(addDays(startOfMonth(d), -1)))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            ‹ Prev
          </button>
          <button
            onClick={() => setAnchor(new Date())}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Today
          </button>
          <button
            onClick={() => setAnchor((d) => startOfMonth(addDays(startOfMonth(d), 32)))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Next ›
          </button>
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-7">
        {WEEKDAY_LABELS.map((label) => (
          <div
            key={label}
            className="border-l border-zinc-800 px-1 py-1 text-center text-[10px] uppercase tracking-wide text-zinc-500"
          >
            {label}
          </div>
        ))}
      </div>

      {error && <p className="py-1 text-sm text-red-400">{error}</p>}
      {loading && <p className="py-1 text-xs text-zinc-600">Loading…</p>}

      <div
        className="grid min-h-0 flex-1 grid-cols-7 border-r border-b border-zinc-800"
        style={{ gridTemplateRows: "repeat(6, minmax(0, 1fr))" }}
      >
        {days.map((day) => (
          <DayCell
            key={day.toISOString()}
            day={day}
            month={month}
            events={events}
            now={now}
            isArmed={isArmed}
            onArm={(e) => void arm(e)}
          />
        ))}
      </div>
    </div>
  );
}

export default function MonthView() {
  return (
    <CalendarConnectionGate>
      <Month />
    </CalendarConnectionGate>
  );
}
