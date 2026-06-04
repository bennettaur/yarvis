import { useEffect, useRef, useState } from "react";
import type { CalendarEvent } from "../../lib/calendar";
import { useEventAlarms } from "../../lib/calendarAlarms";
import {
  addDays,
  assignLanes,
  eventLayout,
  eventsForDay,
  formatHourLabel,
  formatTime,
  formatWeekday,
  formatWeekRange,
  MINUTES_PER_DAY,
  minutesIntoDay,
  sameDay,
  startMs,
  startOfWeekSunday,
  weekDays,
} from "../../lib/calendarGrid";
import { openExternal } from "../../lib/url";
import CalendarConnectionGate from "./CalendarConnectionGate";
import EventAlarmButton from "./EventAlarmButton";
import { useNow, useRangeEvents } from "./useRangeEvents";

/** Pixel height of one hour row; the 24h column is 24× this. */
const HOUR_PX = 48;
const HOURS = Array.from({ length: 24 }, (_, i) => i);
/** Hour the grid scrolls to on load, so the work day is in view first. */
const START_HOUR = 6;

function DayColumn({
  day,
  events,
  now,
  isArmed,
  onArm,
}: {
  day: Date;
  events: CalendarEvent[];
  now: Date;
  isArmed: (e: CalendarEvent) => boolean;
  onArm: (e: CalendarEvent) => void;
}) {
  const { timed } = eventsForDay(events, day);
  const laid = assignLanes(timed);
  const showNow = sameDay(day, now);

  return (
    <div className="relative border-l border-zinc-800" style={{ height: HOUR_PX * 24 }}>
      {HOURS.map((h) => (
        <div
          key={h}
          className="absolute inset-x-0 border-t border-zinc-800/60"
          style={{ top: h * HOUR_PX }}
        />
      ))}

      {laid.map(({ event, lane, lanes }) => {
        const { topPct, heightPct } = eventLayout(event, day);
        const ms = startMs(event);
        return (
          <div
            key={event.id}
            className="absolute overflow-hidden rounded-md border border-indigo-700/60 bg-indigo-950/70 px-1.5 py-1 text-[11px] leading-tight"
            style={{
              top: `${topPct}%`,
              height: `${heightPct}%`,
              left: `${(lane / lanes) * 100}%`,
              width: `${(1 / lanes) * 100}%`,
            }}
            title={event.title}
          >
            <div className="flex items-start justify-between gap-1">
              <span className="truncate font-medium text-zinc-100">{event.title}</span>
              <EventAlarmButton event={event} armed={isArmed(event)} onArm={onArm} compact />
            </div>
            <div className="truncate text-indigo-300">
              {ms !== null && formatTime(new Date(ms))}
              {event.meetLink && (
                <>
                  {" · "}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      openExternal(event.meetLink);
                    }}
                    className="text-indigo-400 hover:underline"
                  >
                    join
                  </button>
                </>
              )}
            </div>
          </div>
        );
      })}

      {showNow && (
        <div
          className="absolute inset-x-0 z-10 border-t-2 border-red-500"
          style={{ top: `${(minutesIntoDay(now) / MINUTES_PER_DAY) * 100}%` }}
        >
          <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
        </div>
      )}
    </div>
  );
}

function Week() {
  const [anchor, setAnchor] = useState(() => new Date());
  const now = useNow();
  const weekStart = startOfWeekSunday(anchor);
  const days = weekDays(anchor);
  const { events, error, loading } = useRangeEvents(weekStart, addDays(weekStart, 7));
  const { isArmed, arm } = useEventAlarms();
  const gridRef = useRef<HTMLDivElement>(null);

  // Start with the work day in view rather than midnight.
  useEffect(() => {
    if (gridRef.current) gridRef.current.scrollTop = START_HOUR * HOUR_PX;
  }, []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 pb-2">
        <h2 className="text-sm font-medium text-zinc-200">{formatWeekRange(weekStart)}</h2>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={() => setAnchor((d) => addDays(d, -7))}
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
            onClick={() => setAnchor((d) => addDays(d, 7))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Next ›
          </button>
        </div>
      </div>

      {/* Weekday header aligned to the columns below (56px hour gutter). */}
      <div className="flex shrink-0">
        <div className="w-14 shrink-0" />
        <div className="grid flex-1 grid-cols-7">
          {days.map((day) => {
            const today = sameDay(day, now);
            return (
              <div
                key={day.toISOString()}
                className={`border-l border-zinc-800 px-1 py-1 text-center text-xs ${
                  today ? "text-indigo-300" : "text-zinc-400"
                }`}
              >
                <div>{formatWeekday(day)}</div>
                <div
                  className={`text-sm ${today ? "font-semibold text-indigo-300" : "text-zinc-300"}`}
                >
                  {day.getDate()}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* All-day band. */}
      <div className="flex shrink-0 border-t border-zinc-800">
        <div className="flex w-14 shrink-0 items-center justify-end pr-1 text-[10px] uppercase text-zinc-600">
          all-day
        </div>
        <div className="grid flex-1 grid-cols-7">
          {days.map((day) => {
            const { allDay } = eventsForDay(events, day);
            return (
              <div
                key={day.toISOString()}
                className="min-h-[1.5rem] space-y-0.5 border-l border-zinc-800 p-0.5"
              >
                {allDay.map((e) => (
                  <div
                    key={e.id}
                    className="truncate rounded bg-zinc-800/70 px-1 text-[10px] text-zinc-200"
                    title={e.title}
                  >
                    {e.title}
                  </div>
                ))}
              </div>
            );
          })}
        </div>
      </div>

      {error && <p className="py-1 text-sm text-red-400">{error}</p>}
      {loading && <p className="py-1 text-xs text-zinc-600">Loading…</p>}

      {/* Scrollable hourly grid. */}
      <div ref={gridRef} className="flex min-h-0 flex-1 overflow-y-auto border-t border-zinc-800">
        <div className="relative w-14 shrink-0" style={{ height: HOUR_PX * 24 }}>
          {HOURS.map((h) => (
            <div
              key={h}
              className="absolute right-1 -translate-y-1/2 text-[10px] text-zinc-600"
              style={{ top: h * HOUR_PX }}
            >
              {h === 0 ? "" : formatHourLabel(h)}
            </div>
          ))}
        </div>
        <div className="grid flex-1 grid-cols-7">
          {days.map((day) => (
            <DayColumn
              key={day.toISOString()}
              day={day}
              events={events}
              now={now}
              isArmed={isArmed}
              onArm={(e) => void arm(e)}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default function WeekView() {
  return (
    <CalendarConnectionGate>
      <Week />
    </CalendarConnectionGate>
  );
}
