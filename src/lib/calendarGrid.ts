import type { CalendarEvent } from "./calendar";

/**
 * Pure date-math and timeline-layout helpers shared by the calendar grid views
 * (week, month, day). Framework-free and side-effect-free so the layout logic
 * can be reasoned about and reused independently of React. All functions work
 * in the browser's local time zone, matching how events are shown to the user.
 */

export const MINUTES_PER_DAY = 24 * 60;

/** Midnight at the start of the given day (local time). */
export function startOfDay(date: Date): Date {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Returns a new date `days` after `date` (negative to go back). */
export function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** Midnight on the Sunday on or before `date` — the start of its week. */
export function startOfWeekSunday(date: Date): Date {
  const d = startOfDay(date);
  return addDays(d, -d.getDay());
}

/** The 7 day-starts of the week containing `date`, Sunday first. */
export function weekDays(date: Date): Date[] {
  const start = startOfWeekSunday(date);
  return Array.from({ length: 7 }, (_, i) => addDays(start, i));
}

/** Midnight on the first of `date`'s month. */
export function startOfMonth(date: Date): Date {
  const d = startOfDay(date);
  d.setDate(1);
  return d;
}

/** Midnight on the first of the month `months` after `date`'s month. */
export function addMonths(date: Date, months: number): Date {
  const d = startOfMonth(date);
  d.setMonth(d.getMonth() + months);
  return d;
}

/**
 * The days filling a 6×7 month grid: the month's days plus the leading and
 * trailing days needed to start on Sunday and end on Saturday. Always 42 cells
 * so the grid height is stable across months.
 */
export function monthGridDays(date: Date): Date[] {
  const first = startOfMonth(date);
  const gridStart = startOfWeekSunday(first);
  return Array.from({ length: 42 }, (_, i) => addDays(gridStart, i));
}

/** True when both dates fall on the same local calendar day. */
export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Parsed start time in ms, or null when missing/unparseable. */
export function startMs(event: CalendarEvent): number | null {
  const t = Date.parse(event.start);
  return Number.isNaN(t) ? null : t;
}

/** Parsed end time in ms, or null when missing/unparseable. */
export function endMs(event: CalendarEvent): number | null {
  const t = Date.parse(event.end);
  return Number.isNaN(t) ? null : t;
}

/**
 * Events that intersect the given day, split into all-day and timed buckets.
 * Timed events are sorted by start so callers render them in chronological
 * order; all-day events keep their incoming order.
 */
export function eventsForDay(
  events: CalendarEvent[],
  day: Date,
): { allDay: CalendarEvent[]; timed: CalendarEvent[] } {
  const dayStart = startOfDay(day).getTime();
  const dayEnd = dayStart + MINUTES_PER_DAY * 60_000;
  const allDay: CalendarEvent[] = [];
  const timed: CalendarEvent[] = [];
  for (const event of events) {
    if (event.allDay) {
      if (allDayIntersectsDay(event, day)) allDay.push(event);
      continue;
    }
    const start = startMs(event);
    const end = endMs(event) ?? (start !== null ? start : null);
    if (start === null || end === null) continue;
    if (start < dayEnd && end > dayStart) timed.push(event);
  }
  timed.sort((a, b) => (startMs(a) ?? 0) - (startMs(b) ?? 0));
  return { allDay, timed };
}

/**
 * All-day events use date-only ISO strings with an exclusive end date, so
 * compare on the date span rather than parsed timestamps (which would be
 * skewed by the local time zone).
 */
function allDayIntersectsDay(event: CalendarEvent, day: Date): boolean {
  const start = event.start.slice(0, 10);
  const end = event.end.slice(0, 10) || start;
  const key = isoDateKey(day);
  return start <= key && key < end;
}

/** Local YYYY-MM-DD key for a date (not UTC). */
export function isoDateKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Minutes elapsed from local midnight to `date` (0–1440). */
export function minutesIntoDay(date: Date): number {
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * Vertical placement of a timed event on a single day's 24h axis, as
 * percentages of the day height. Clamped to the day so events that start before
 * or end after the day still render a visible sliver within it.
 */
export function eventLayout(
  event: CalendarEvent,
  day: Date,
): { topPct: number; heightPct: number } {
  const dayStart = startOfDay(day).getTime();
  const start = startMs(event) ?? dayStart;
  const end = endMs(event) ?? start + 30 * 60_000;
  const startMin = clamp((start - dayStart) / 60_000, 0, MINUTES_PER_DAY);
  const endMin = clamp((end - dayStart) / 60_000, 0, MINUTES_PER_DAY);
  const topPct = (startMin / MINUTES_PER_DAY) * 100;
  const heightPct = (Math.max(endMin - startMin, 15) / MINUTES_PER_DAY) * 100;
  return { topPct, heightPct };
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

export interface LaidOutEvent {
  event: CalendarEvent;
  /** 0-based column among overlapping events. */
  lane: number;
  /** Total columns this event must share its time span with. */
  lanes: number;
}

/**
 * Assigns overlapping timed events to side-by-side lanes so they don't stack on
 * top of each other (the Google-Calendar column-packing behaviour). Greedy: an
 * event reuses the first lane free at its start; the lane count for a cluster of
 * mutually-overlapping events is shared so each gets an equal width slice.
 * Expects events pre-sorted by start (as `eventsForDay` returns them).
 */
export function assignLanes(events: CalendarEvent[]): LaidOutEvent[] {
  const result: LaidOutEvent[] = [];
  let cluster: { event: CalendarEvent; lane: number; end: number }[] = [];
  let clusterMaxEnd = -Infinity;

  const flush = () => {
    const lanes = cluster.reduce((maxLane, c) => Math.max(maxLane, c.lane + 1), 0);
    for (const c of cluster) result.push({ event: c.event, lane: c.lane, lanes });
    cluster = [];
    clusterMaxEnd = -Infinity;
  };

  for (const event of events) {
    const start = startMs(event) ?? 0;
    const end = endMs(event) ?? start;
    // A gap with no overlap ends the current cluster and its shared width.
    if (start >= clusterMaxEnd && cluster.length) flush();
    const taken = new Set(cluster.filter((c) => c.end > start).map((c) => c.lane));
    let lane = 0;
    while (taken.has(lane)) lane++;
    cluster.push({ event, lane, end });
    clusterMaxEnd = Math.max(clusterMaxEnd, end);
  }
  if (cluster.length) flush();
  return result;
}

const TIME_FMT = new Intl.DateTimeFormat(undefined, {
  hour: "numeric",
  minute: "2-digit",
});

/** Short local time like "9:00 AM". */
export function formatTime(date: Date): string {
  return TIME_FMT.format(date);
}

/** Hour-of-day axis label like "9 AM" / "12 PM" (0–23). */
export function formatHourLabel(hour: number): string {
  const h = ((hour + 11) % 12) + 1;
  const suffix = hour < 12 ? "AM" : "PM";
  return `${h} ${suffix}`;
}

const MONTH_YEAR_FMT = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});

/** "June 2026" for a month header. */
export function formatMonthLabel(date: Date): string {
  return MONTH_YEAR_FMT.format(date);
}

const RANGE_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});

/** "May 24 – May 30" for a week header (start inclusive, 6 days later). */
export function formatWeekRange(weekStart: Date): string {
  const end = addDays(weekStart, 6);
  return `${RANGE_DAY_FMT.format(weekStart)} – ${RANGE_DAY_FMT.format(end)}`;
}

const WEEKDAY_FMT = new Intl.DateTimeFormat(undefined, { weekday: "short" });

/** "Sun", "Mon", … for a column header. */
export function formatWeekday(date: Date): string {
  return WEEKDAY_FMT.format(date);
}

const FULL_DAY_FMT = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
});

/** "Wednesday, June 3" for a day-view header. */
export function formatFullDay(date: Date): string {
  return FULL_DAY_FMT.format(date);
}
