import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  alarmInvoke,
  alarmListen,
  fireAlarm,
  setCoreAlarms,
  UNHANDLED,
} from "../test/alarmFixture";
import { nativeInvoke } from "../test/nativeInvoke";
import type { Alarm } from "./alarms";

/**
 * Guards issue #201: two alarms set for the same time fire in one scheduler
 * tick, and before this the frontend kept a single "active alarm", so the
 * second event overwrote the first and dismissing the survivor left the other
 * ringing with no way to reach it. The takeover queue has to hold every alarm
 * that fired and hand over to the next as each is dealt with.
 */

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    const result = alarmInvoke(command, args ?? {});
    return result === UNHANDLED ? nativeInvoke(command) : result;
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: Alarm }) => void) =>
    alarmListen(event, handler),
}));

const { acknowledgeAlarm, useAlarmTakeoverQueue, useRingingAlarms } = await import("./alarmStore");

const scheduled = (id: string, fireAtMs: number): Alarm => ({
  id,
  label: id,
  fireAtMs,
  sound: true,
  meetLink: null,
  status: "scheduled",
});

function Probe() {
  const queue = useAlarmTakeoverQueue();
  const ringing = useRingingAlarms();
  return createElement(
    "div",
    null,
    createElement("div", { "data-queue": queue.map((a) => a.id).join(",") }),
    createElement("div", { "data-ringing": ringing.map((a) => a.id).join(",") }),
  );
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

// Torn down even when an expectation throws: a mount left behind keeps the
// store subscribed, and the next test's first subscriber is the one that
// triggers the refresh it needs to see its own alarms.
let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

afterEach(() => {
  mounted?.root.unmount();
  mounted?.host.remove();
  mounted = null;
});

/** Mounts the probe and returns readers for the two lists. */
async function mountProbe() {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  root.render(createElement(Probe));
  await settle();

  const read = (attr: string) => host.querySelector(`[data-${attr}]`)?.getAttribute(`data-${attr}`);
  return { queue: () => read("queue"), ringing: () => read("ringing") };
}

describe("alarm takeover queue", () => {
  it("keeps every alarm that fired and advances as each is dismissed", async () => {
    const at = Date.now();
    setCoreAlarms([scheduled("same-a", at), scheduled("same-b", at)]);

    const probe = await mountProbe();
    fireAlarm("same-a");
    fireAlarm("same-b");
    await settle();

    expect(probe.queue()).toBe("same-a,same-b");

    await acknowledgeAlarm("same-a");
    await settle();

    // The second alarm is still reachable rather than stranded behind the first.
    expect(probe.queue()).toBe("same-b");

    await acknowledgeAlarm("same-b");
    await settle();

    expect(probe.queue()).toBe("");
  });

  it("lists an alarm left firing by a previous run without taking the screen over", async () => {
    setCoreAlarms([{ ...scheduled("stale", Date.now() - 60_000), status: "fired" }]);

    const probe = await mountProbe();

    expect(probe.ringing()).toBe("stale");
    expect(probe.queue()).toBe("");
  });
});
