import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../../test/render";

/**
 * Render smoke tests for the calendar views. They stub the sidecar data layer
 * (sidecarFetch) so the real calendar lib, the shared alarm store, and the
 * per-day memoization all execute against a connected calendar with events, and
 * assert the views produce their grid + a now-line without runtime errors.
 */

const at = (hour: number, minute = 0): string => {
  const d = new Date();
  d.setHours(hour, minute, 0, 0);
  return d.toISOString();
};
const todayDateOnly = () => new Date().toISOString().slice(0, 10);

const EVENTS = [
  {
    id: "standup",
    title: "Standup",
    start: at(9),
    end: at(9, 30),
    allDay: false,
    location: null,
    meetLink: "https://meet.google.com/abc",
    htmlLink: null,
  },
  {
    id: "overlap",
    title: "Overlapping sync",
    start: at(9, 15),
    end: at(10),
    allDay: false,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
  {
    id: "review",
    title: "Design review",
    start: at(14),
    end: at(15),
    allDay: false,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
  {
    id: "holiday",
    title: "Company holiday",
    start: todayDateOnly(),
    end: todayDateOnly(),
    allDay: true,
    location: null,
    meetLink: null,
    htmlLink: null,
  },
];

mock.module("../../lib/api", () => ({
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

const { default: WeekView } = await import("./WeekView");
const { default: MonthView } = await import("./MonthView");
const { default: DayTimeline } = await import("./DayTimeline");

describe("WeekView", () => {
  it("renders the timed events, the all-day band, and the now-line", async () => {
    const html = await renderToHtml(createElement(WeekView));
    expect(html).toContain("Standup");
    expect(html).toContain("Design review");
    expect(html).toContain("all-day");
    expect(html).toContain("border-red-500");
  });
});

describe("MonthView", () => {
  it("renders the weekday header and the day's events", async () => {
    const html = await renderToHtml(createElement(MonthView));
    expect(html).toContain("Sun");
    expect(html).toContain("Standup");
  });
});

describe("DayTimeline", () => {
  it("renders the vertical orientation with events and a now-line", async () => {
    const html = await renderToHtml(createElement(DayTimeline, { orientation: "vertical" }));
    expect(html).toContain("Standup");
    expect(html).toContain("border-red-500");
  });

  it("renders the horizontal orientation", async () => {
    const html = await renderToHtml(createElement(DayTimeline, { orientation: "horizontal" }));
    expect(html).toContain("Standup");
  });
});
