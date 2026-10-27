import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, useEffect, useRef } from "react";
import { fakeAlarms } from "../test/alarmFixture";
import { renderToHtml } from "../test/render";
import type { CalendarEvent } from "./calendar";

/**
 * Guards the meeting → alarm wiring that fulfills issue #68: arming a calendar
 * event must forward its join link into `createAlarm`. This is a positional
 * call — createAlarm(label, fireAtMs, sound, meetLink) — so a dropped or
 * reordered argument would compile and typecheck while silently losing the
 * link, which only a behavior test at this boundary catches.
 */

const created: Array<Record<string, unknown>> = [];

mock.module("./alarms", () => ({
  ...fakeAlarms,
  createAlarm: async (label: string, fireAtMs: number, sound: boolean, meetLink: string | null) => {
    created.push({ label, fireAtMs, sound, meetLink });
    return { id: "generated", status: "scheduled", label, fireAtMs, sound, meetLink };
  },
}));

const { useEventAlarms } = await import("./calendarAlarms");

const futureEvent = (meetLink: string | null): CalendarEvent => ({
  id: "evt",
  title: "Standup",
  start: new Date(Date.now() + 60 * 60_000).toISOString(),
  end: new Date(Date.now() + 90 * 60_000).toISOString(),
  allDay: false,
  location: null,
  meetLink,
  htmlLink: null,
});

// Arms the event exactly once on mount; the ref guards against re-arming when
// the shared alarm store notifies and re-renders the hook.
function ArmOnMount({ event }: { event: CalendarEvent }) {
  const { arm } = useEventAlarms();
  const armed = useRef(false);
  useEffect(() => {
    if (armed.current) return;
    armed.current = true;
    void arm(event);
  }, [arm, event]);
  return null;
}

describe("useEventAlarms arm()", () => {
  beforeEach(() => {
    created.length = 0;
  });

  it("forwards the event's meet link into createAlarm", async () => {
    await renderToHtml(
      createElement(ArmOnMount, { event: futureEvent("https://meet.google.com/abc") }),
    );

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      label: "Meeting: Standup",
      sound: true,
      meetLink: "https://meet.google.com/abc",
    });
  });

  it("forwards a null meet link for events without one", async () => {
    await renderToHtml(createElement(ArmOnMount, { event: futureEvent(null) }));

    expect(created).toHaveLength(1);
    expect(created[0]?.meetLink).toBeNull();
  });
});
