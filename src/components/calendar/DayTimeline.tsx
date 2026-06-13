import { useEffect, useMemo, useRef, useState } from "react";
import type { CalendarEvent } from "../../lib/calendar";
import { useEventAlarms } from "../../lib/calendarAlarms";
import {
  addDays,
  assignLanes,
  endMs,
  eventsForDay,
  formatFullDay,
  formatHourLabel,
  formatTime,
  isoDateKey,
  minutesIntoDay,
  sameDay,
  startMs,
  startOfDay,
} from "../../lib/calendarGrid";
import { openExternal } from "../../lib/url";
import CalendarConnectionGate from "./CalendarConnectionGate";
import EventAlarmButton from "./EventAlarmButton";
import { useNow, useRangeEvents } from "./useRangeEvents";

export type Orientation = "vertical" | "horizontal";

/** Pixels per minute along the time axis, per orientation. */
const PX_PER_MIN: Record<Orientation, number> = { vertical: 1.1, horizontal: 2 };
/** Span (px) reserved across the cross-axis for hour labels. */
const GUTTER_PX = 52;
const HOURS = Array.from({ length: 25 }, (_, i) => i);
/** Hour to rest at the start of the view when not centered on "now". */
const START_HOUR = 6;

/** Parses a date-input value ("YYYY-MM-DD") as a local calendar day. */
function parseDateInput(value: string): Date | null {
  const [y, m, d] = value.split("-").map(Number);
  if (!y || !m || !d) return null;
  return new Date(y, m - 1, d);
}

interface Geom {
  /** Offset along the time axis (px from midnight). */
  offset: number;
  /** Extent along the time axis (px). */
  size: number;
}

function geometry(event: CalendarEvent, day: Date, pxPerMin: number): Geom {
  const dayStart = startOfDay(day).getTime();
  const start = startMs(event) ?? dayStart;
  const end = endMs(event) ?? start + 30 * 60_000;
  const startMin = Math.max(0, (start - dayStart) / 60_000);
  const durMin = Math.max(15, (end - start) / 60_000);
  return { offset: startMin * pxPerMin, size: durMin * pxPerMin };
}

function Timeline({ orientation, initialDate }: { orientation: Orientation; initialDate?: Date }) {
  const vertical = orientation === "vertical";
  const pxPerMin = PX_PER_MIN[orientation];
  const axisPx = 24 * 60 * pxPerMin;
  const now = useNow();
  const [day, setDay] = useState(() => initialDate ?? new Date());
  const { events, error, loading } = useRangeEvents(startOfDay(day), addDays(startOfDay(day), 1));
  const { isArmed, arm } = useEventAlarms();
  const scrollRef = useRef<HTMLDivElement>(null);

  const showNow = sameDay(day, now);
  const nowOffset = minutesIntoDay(now) * pxPerMin;
  const dayKey = isoDateKey(day);

  // Viewing today: keep the current time centered so upcoming events move toward
  // the center line and past ones move away as time advances.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !showNow) return;
    if (vertical) {
      el.scrollTop = nowOffset - el.clientHeight / 2;
    } else {
      el.scrollLeft = nowOffset - el.clientWidth / 2;
    }
  }, [vertical, nowOffset, showNow]);

  // Viewing another day: rest at the start of the work day. Keyed on the day so
  // it lands there once on switch rather than fighting manual scrolling. dayKey
  // isn't read in the body but is a required trigger: switching between two
  // non-today days changes nothing else in the deps.
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-run to reset scroll when the viewed day changes
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || showNow) return;
    const offset = START_HOUR * 60 * pxPerMin;
    if (vertical) el.scrollTop = offset;
    else el.scrollLeft = offset;
  }, [dayKey, vertical, pxPerMin, showNow]);

  // Recompute the day's buckets only when its events or the day change, not on
  // the now-tick that drives the center line. Keyed on dayKey because `day` is a
  // fresh Date each render.
  // biome-ignore lint/correctness/useExhaustiveDependencies: keyed on dayKey, not the unstable day object
  const { allDay, laid } = useMemo(() => {
    const { allDay, timed } = eventsForDay(events, day);
    return { allDay, laid: assignLanes(timed) };
  }, [events, dayKey]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 pb-2">
        <h2 className="text-sm font-medium text-zinc-200">{formatFullDay(day)}</h2>
        {allDay.length > 0 && (
          <span
            className="truncate text-xs text-zinc-500"
            title={allDay.map((e) => e.title).join(", ")}
          >
            · {allDay.map((e) => e.title).join(", ")}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <button
            type="button"
            onClick={() => setDay((d) => addDays(d, -1))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            ‹ Prev
          </button>
          <button
            type="button"
            onClick={() => setDay(new Date())}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Today
          </button>
          <button
            type="button"
            onClick={() => setDay((d) => addDays(d, 1))}
            className="rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-800"
          >
            Next ›
          </button>
          <input
            type="date"
            value={dayKey}
            onChange={(e) => {
              const picked = parseDateInput(e.target.value);
              if (picked) setDay(picked);
            }}
            className="rounded-md border border-zinc-700 bg-zinc-800 px-2 py-1 text-xs"
          />
        </div>
      </div>

      {error && <p className="py-1 text-sm text-red-400">{error}</p>}
      {loading && <p className="py-1 text-xs text-zinc-600">Loading…</p>}

      <div
        ref={scrollRef}
        className={`min-h-0 flex-1 border-t border-zinc-800 ${
          vertical ? "overflow-y-auto" : "overflow-x-auto"
        }`}
      >
        <div
          className="relative"
          style={
            vertical
              ? { height: axisPx, paddingLeft: GUTTER_PX }
              : { width: axisPx, height: "100%", paddingTop: GUTTER_PX }
          }
        >
          {/* Hour markers + gridlines along the time axis. */}
          {HOURS.map((h) => {
            const pos = h * 60 * pxPerMin;
            return vertical ? (
              <div key={h} className="absolute inset-x-0" style={{ top: pos }}>
                <div className="border-t border-zinc-800/60" />
                <div className="absolute left-1 -top-2 text-[10px] text-zinc-600">
                  {h < 24 && h > 0 ? formatHourLabel(h) : ""}
                </div>
              </div>
            ) : (
              <div key={h} className="absolute inset-y-0" style={{ left: pos }}>
                <div className="h-full border-l border-zinc-800/60" />
                <div className="absolute top-1 left-1 text-[10px] text-zinc-600">
                  {h < 24 && h > 0 ? formatHourLabel(h) : ""}
                </div>
              </div>
            );
          })}

          {/* Events positioned along the time axis, lane-packed across it. */}
          {laid.map(({ event, lane, lanes }) => {
            const { offset, size } = geometry(event, day, pxPerMin);
            const ms = startMs(event);
            const laneStyle = vertical
              ? {
                  top: offset,
                  height: size,
                  left: `calc(${GUTTER_PX}px + ${(lane / lanes) * 100}% - ${
                    (GUTTER_PX * lane) / lanes
                  }px)`,
                  width: `calc((100% - ${GUTTER_PX}px) / ${lanes})`,
                }
              : {
                  left: offset,
                  width: size,
                  top: `calc(${GUTTER_PX}px + (100% - ${GUTTER_PX}px) * ${lane} / ${lanes})`,
                  height: `calc((100% - ${GUTTER_PX}px) / ${lanes})`,
                };
            return (
              <div
                key={event.id}
                className="absolute overflow-hidden rounded-md border border-indigo-700/60 bg-indigo-950/70 px-1.5 py-1 text-[11px] leading-tight"
                style={laneStyle}
                title={event.title}
              >
                <div className="flex items-start justify-between gap-1">
                  <span className="truncate font-medium text-zinc-100">{event.title}</span>
                  <EventAlarmButton
                    event={event}
                    armed={isArmed(event)}
                    onArm={(e) => void arm(e)}
                    compact
                  />
                </div>
                <div className="truncate text-indigo-300">
                  {ms !== null && formatTime(new Date(ms))}
                  {event.meetLink && (
                    <>
                      {" · "}
                      <button
                        type="button"
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

          {/* Current-time line; centered in the viewport via auto-scroll. */}
          {showNow &&
            (vertical ? (
              <div
                className="absolute inset-x-0 z-10 border-t-2 border-red-500"
                style={{ top: nowOffset }}
              >
                <div className="absolute -left-1 -top-1 h-2 w-2 rounded-full bg-red-500" />
              </div>
            ) : (
              <div
                className="absolute inset-y-0 z-10 border-l-2 border-red-500"
                style={{ left: nowOffset }}
              >
                <div className="absolute -top-1 -left-1 h-2 w-2 rounded-full bg-red-500" />
              </div>
            ))}
        </div>
      </div>
    </div>
  );
}

/**
 * A single day rendered as a scrolling timeline with a center "now" line and
 * hour markers along the lead axis. `orientation` selects a vertical
 * (scroll up/down) or horizontal (scroll left/right) layout. Defaults to today.
 */
export default function DayTimeline({
  orientation = "vertical",
  date,
}: {
  orientation?: Orientation;
  date?: Date;
}) {
  return (
    <CalendarConnectionGate>
      <Timeline orientation={orientation} initialDate={date} />
    </CalendarConnectionGate>
  );
}
