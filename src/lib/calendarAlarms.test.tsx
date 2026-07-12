import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement, useEffect, useRef } from "react";
import { renderToHtml } from "../test/render";
import type { CalendarEvent } from "./calendar";

/**
 * Guards the meeting → alarm wiring that fulfills issue #68: arming a calendar
 * event must forward its join link into `create_alarm`. This is a positional
 * call — createAlarm(label, fireAtMs, sound, meetLink) — so a dropped or
 * reordered argument would compile and typecheck while silently losing the
 * link, which only a behavior test at this boundary catches.
 */

const created: Array<Record<string, unknown>> = [];

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "create_alarm") {
      created.push(args);
      return { id: "generated", status: "scheduled", ...args };
    }
    return command === "list_alarms" ? [] : undefined;
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

  it("forwards the event's meet link into create_alarm", async () => {
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
