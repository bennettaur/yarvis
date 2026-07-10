import { describe, expect, it } from "bun:test";
import type { CalendarEvent } from "./calendar";
import {
  addMonths,
  assignLanes,
  eventLayout,
  eventsForDay,
  groupEventsByDay,
  isoDateKey,
  monthGridDays,
  weekDays,
} from "./calendarGrid";

const ev = (id: string, start: string, end: string, allDay = false): CalendarEvent => ({
  id,
  title: id,
  start,
  end,
  allDay,
  location: null,
  meetLink: null,
  htmlLink: null,
});

// These assertions assume the runner's local zone observes US/Canada DST. CI
// and local dev both run in such a zone; the dates below are real transition
// days in America/Toronto (the project author's zone).

describe("eventsForDay — DST boundaries", () => {
  it("buckets a late-night event into the 25-hour fall-back day, not the next", () => {
    const lateNov2 = ev("late", "2025-11-02T23:30:00-05:00", "2025-11-03T00:00:00-05:00");
    const earlyNov3 = ev("early", "2025-11-03T00:30:00-05:00", "2025-11-03T01:00:00-05:00");
    const nov2 = eventsForDay([lateNov2, earlyNov3], new Date(2025, 10, 2));
    expect(nov2.timed.map((e) => e.id)).toEqual(["late"]);

    const nov3 = eventsForDay([lateNov2, earlyNov3], new Date(2025, 10, 3));
    expect(nov3.timed.map((e) => e.id)).toEqual(["early"]);
  });

  it("buckets a late-night event into the 23-hour spring-forward day, not the next", () => {
    const lateMar9 = ev("late", "2025-03-09T23:30:00-04:00", "2025-03-09T23:59:00-04:00");
    expect(eventsForDay([lateMar9], new Date(2025, 2, 9)).timed.map((e) => e.id)).toEqual(["late"]);
    expect(eventsForDay([lateMar9], new Date(2025, 2, 10)).timed).toHaveLength(0);
  });

  it("separates all-day events from timed and sorts timed by start", () => {
    const day = new Date(2025, 5, 10);
    const a = ev("a", "2025-06-10T14:00:00-04:00", "2025-06-10T15:00:00-04:00");
    const b = ev("b", "2025-06-10T09:00:00-04:00", "2025-06-10T10:00:00-04:00");
    const holiday = ev("holiday", "2025-06-10", "2025-06-11", true);
    const { allDay, timed } = eventsForDay([a, holiday, b], day);
    expect(allDay.map((e) => e.id)).toEqual(["holiday"]);
    expect(timed.map((e) => e.id)).toEqual(["b", "a"]);
  });
});

describe("assignLanes", () => {
  it("packs overlapping events into separate lanes and isolates non-overlapping ones", () => {
    const a = ev("A", "2025-06-10T09:00:00-04:00", "2025-06-10T10:00:00-04:00");
    const b = ev("B", "2025-06-10T09:30:00-04:00", "2025-06-10T10:30:00-04:00");
    const c = ev("C", "2025-06-10T11:00:00-04:00", "2025-06-10T11:30:00-04:00");
    const laid = assignLanes([a, b, c]);
    const byId = Object.fromEntries(laid.map((l) => [l.event.id, l]));
    expect(byId.A.lane).not.toBe(byId.B.lane);
    expect([byId.A.lanes, byId.B.lanes]).toEqual([2, 2]);
    expect([byId.C.lane, byId.C.lanes]).toEqual([0, 1]);
  });
});

describe("week and month grids", () => {
  it("returns 7 days starting on Sunday", () => {
    const days = weekDays(new Date(2025, 5, 11)); // Wed Jun 11 2025
    expect(days).toHaveLength(7);
    expect(days[0].getDay()).toBe(0);
    expect(isoDateKey(days[0])).toBe("2025-06-08");
  });

  it("returns a 42-cell month grid aligned to Sunday", () => {
    const grid = monthGridDays(new Date(2025, 5, 1));
    expect(grid).toHaveLength(42);
    expect(grid[0].getDay()).toBe(0);
  });
});

describe("addMonths", () => {
  it("wraps across year boundaries and snaps to the first of the month", () => {
    expect(isoDateKey(addMonths(new Date(2025, 11, 15), 1))).toBe("2026-01-01");
    expect(isoDateKey(addMonths(new Date(2025, 0, 15), -1))).toBe("2024-12-01");
  });

  it("does not overflow from a long month into a skipped one", () => {
    // Mar 31 + 1 month must land on Apr 1, not "Mar 31 + 31 days" = May 1.
    expect(isoDateKey(addMonths(new Date(2025, 2, 31), 1))).toBe("2025-04-01");
  });
});

describe("eventLayout", () => {
  it("positions a midday one-hour event by percentage of the day", () => {
    const day = new Date(2025, 5, 10);
    const noon = ev("noon", "2025-06-10T12:00:00-04:00", "2025-06-10T13:00:00-04:00");
    const { topPct, heightPct } = eventLayout(noon, day);
    expect(topPct).toBeCloseTo(50, 0);
    expect(heightPct).toBeCloseTo((60 / 1440) * 100, 1);
  });
});

describe("groupEventsByDay", () => {
  it("groups events by their local start date and sorts by date", () => {
    const a = ev("a", "2025-06-10T14:00:00-04:00", "2025-06-10T15:00:00-04:00");
    const b = ev("b", "2025-06-10T09:00:00-04:00", "2025-06-10T10:00:00-04:00");
    const c = ev("c", "2025-06-11T10:00:00-04:00", "2025-06-11T11:00:00-04:00");
    const holiday = ev("holiday", "2025-06-10", "2025-06-11", true);

    const groups = groupEventsByDay([a, c, holiday, b]);
    expect(groups).toHaveLength(2);

    expect(isoDateKey(groups[0].date)).toBe("2025-06-10");
    expect(groups[0].events.map((e) => e.id)).toEqual(["a", "holiday", "b"]);

    expect(isoDateKey(groups[1].date)).toBe("2025-06-11");
    expect(groups[1].events.map((e) => e.id)).toEqual(["c"]);
  });
});
