import { afterAll, describe, expect, it, mock, setSystemTime } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../test/render";
import CalendarPanel from "./CalendarPanel";

setSystemTime(new Date("2026-06-17T12:00:00"));

const at = (days: number, hour: number, minute = 0): string => {
  const d = new Date("2026-06-17T12:00:00");
  d.setDate(d.getDate() + days);
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};

const dateOnly = (days: number): string => {
  const d = new Date("2026-06-17T12:00:00");
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
};

const EVENTS = [
  {
    id: "today-1",
    title: "Today Event 1",
    start: at(0, 14),
    end: at(0, 15),
    allDay: false,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
  {
    id: "today-allday",
    title: "Today All Day",
    start: dateOnly(0),
    end: dateOnly(1),
    allDay: true,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
  {
    id: "tomorrow-1",
    title: "Tomorrow Event 1",
    start: at(1, 10),
    end: at(1, 11),
    allDay: false,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
  {
    id: "future-1",
    title: "Future Event 1",
    start: at(2, 9),
    end: at(2, 10),
    allDay: false,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
];

mock.module("../lib/api", () => ({
  sidecarFetch: async (path: string) => {
    const body = path.includes("/status")
      ? { configured: true, connected: true, scope: "ro" }
      : path.includes("/events")
        ? EVENTS
        : {};
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

afterAll(() => setSystemTime());

describe("Agenda View Grouping", () => {
  it("renders events grouped by day with correct headers", async () => {
    const html = await renderToHtml(createElement(CalendarPanel));

    // Check for Today header
    expect(html).toContain("Today");
    expect(html).toContain("Wednesday, June 17");
    expect(html).toContain("Today Event 1");
    expect(html).toContain("Today All Day");

    // Check for Tomorrow header
    expect(html).toContain("Tomorrow");
    expect(html).toContain("Thursday, June 18");
    expect(html).toContain("Tomorrow Event 1");

    // Check for Future date header (no Today/Tomorrow prefix)
    expect(html).toContain("Friday, June 19");
    expect(html).toContain("Future Event 1");

    // Verify times are formatted simply (without full date)
    expect(html).toContain("2:00 PM"); // Today Event 1 starts at 14:00
    expect(html).toContain("10:00 AM"); // Tomorrow Event 1 starts at 10:00
    expect(html).toContain("9:00 AM"); // Future Event 1 starts at 9:00
    expect(html).toContain("All day");
  });
});
