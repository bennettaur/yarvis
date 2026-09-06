import { afterAll, describe, expect, it, mock, setSystemTime } from "bun:test";
import { createElement } from "react";
import { renderToHtml } from "../../test/render";

/**
 * Render smoke tests for the calendar views. They stub the sidecar data layer
 * (sidecarFetch) so the real calendar lib, the shared alarm store, and the
 * per-day memoization all execute against a connected calendar with events, and
 * assert the views produce their grid + a now-line without runtime errors.
 */

// Freeze the clock before building EVENTS so the event times and the "now" the
// views compute at render share one instant. Without this the suite flakes
// across a midnight (or Saturday→Sunday) boundary: events captured "today" at
// module load fall on a different day/week than the views render, so today's
// events vanish from the grid. A mid-week midday keeps the now-line on screen.
setSystemTime(new Date("2026-06-17T12:00:00"));

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
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: a naive stub here would leak
  // into any other test file that runs in the same process (`mock.module` is
  // process-global, not file-scoped) and break its assertions about the
  // actual error-detail-extraction behavior.
  ensureOk: async (res: Response, context: string) => {
    if (res.ok) return;
    let raw = "";
    try {
      raw = (await res.text()).trim();
    } catch {
      // no body to read
    }
    let detail: string | null = null;
    if (raw) {
      try {
        const body = JSON.parse(raw) as { error?: unknown };
        const err = body?.error;
        if (typeof err === "string") {
          detail = err;
        } else if (err && typeof err === "object") {
          const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
          const parts: string[] = [];
          if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
          for (const [field, msgs] of Object.entries(flat.fieldErrors ?? {})) {
            if (Array.isArray(msgs) && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
          }
          if (parts.length) detail = parts.join("; ");
        }
        if (detail === null) detail = raw;
      } catch {
        detail = raw;
      }
    }
    throw new Error(
      detail ? `${context} failed (${res.status}): ${detail}` : `${context} failed: ${res.status}`,
    );
  },
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  streamSSE: async function* streamSSE() {},
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

// Restore the real clock so the frozen time does not leak into other files in
// the same `bun test` run.
afterAll(() => setSystemTime());

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
