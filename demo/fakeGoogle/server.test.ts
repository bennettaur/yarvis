import { describe, expect, it } from "bun:test";
import { createFakeGoogle } from "./server";

type Event = { id: string; summary: string; start: { dateTime?: string; date?: string } };

describe("fake Google Calendar", () => {
  const list = (handle: ReturnType<typeof createFakeGoogle>, params: Record<string, string>) =>
    (
      handle({
        method: "GET",
        url: new URL(
          `/calendar/v3/calendars/primary/events?${new URLSearchParams(params)}`,
          "http://fake",
        ),
        body: undefined,
      }).json as { items: Event[] }
    ).items;

  it("returns only events in the requested range, soonest first", () => {
    const handle = createFakeGoogle();
    const now = new Date();
    const tomorrowEnd = new Date(now.getTime() + 2 * 86_400_000).toISOString();
    const items = list(handle, { timeMin: now.toISOString(), timeMax: tomorrowEnd });
    const starts = items.map((e) =>
      new Date(e.start.dateTime ?? `${e.start.date}T00:00`).getTime(),
    );
    expect(items.length).toBeGreaterThan(0);
    expect(starts).toEqual([...starts].sort((a, b) => a - b));
    expect(items.some((e) => e.id === "offsite")).toBe(false);
  });

  it("caps the list at maxResults", () => {
    const handle = createFakeGoogle();
    expect(list(handle, { timeMin: new Date(0).toISOString(), maxResults: "2" })).toHaveLength(2);
  });

  it("keeps an event the app creates, so it shows in later lists", () => {
    const handle = createFakeGoogle();
    const start = new Date(Date.now() + 3_600_000).toISOString();
    const end = new Date(Date.now() + 5_400_000).toISOString();
    handle({
      method: "POST",
      url: new URL("/calendar/v3/calendars/primary/events?conferenceDataVersion=1", "http://fake"),
      body: { summary: "Rollout sync", start: { dateTime: start }, end: { dateTime: end } },
    });
    const items = list(handle, { timeMin: new Date().toISOString() });
    expect(items.some((e) => e.summary === "Rollout sync")).toBe(true);
  });
});
