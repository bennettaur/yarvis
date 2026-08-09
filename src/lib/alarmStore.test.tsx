import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import {
  alarmInvoke,
  alarmListen,
  fireAlarm,
  resetCoreAlarms,
  setCoreAlarms,
  UNHANDLED,
} from "../test/alarmFixture";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction } from "../test/render";
import type { Alarm } from "./alarms";

/**
 * Guards issue #201: two alarms set for the same time fire in one scheduler
 * tick, and before this the frontend kept a single "active alarm", so the
 * second event overwrote the first and dismissing the survivor left the other
 * ringing with no way to reach it. The takeover queue has to hold every alarm
 * that fired and hand over to the next as each is dealt with.
 */

let failNextList = false;
/** Holds the next `list_alarms` open so a later read can overtake it. */
let delayNextListMs = 0;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: Record<string, unknown>) => {
    if (command === "list_alarms" && failNextList) {
      failNextList = false;
      throw new Error("list_alarms failed");
    }
    const result = alarmInvoke(command, args ?? {});
    if (command === "list_alarms" && delayNextListMs > 0) {
      const ms = delayNextListMs;
      delayNextListMs = 0;
      // The list is snapshotted before the wait, so this call resolves with
      // what the core held when it was issued — the whole point of the race.
      await new Promise((resolve) => setTimeout(resolve, ms));
    }
    return result === UNHANDLED ? nativeInvoke(command) : result;
  },
}));

mock.module("@tauri-apps/api/event", () => ({
  listen: async (event: string, handler: (e: { payload: Alarm }) => void) =>
    alarmListen(event, handler),
}));

const { acknowledgeAlarm, refreshAlarms, snoozeAlarm, useAlarmTakeoverQueue, useRingingAlarms } =
  await import("./alarmStore");

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

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  failNextList = false;
  delayNextListMs = 0;
});

afterAll(resetCoreAlarms);

/** Mounts the probe and returns readers for the two lists. */
async function mountProbe() {
  const mounted = await mountForInteraction(createElement(Probe), 50);
  unmount = mounted.unmount;
  const read = (attr: string) =>
    mounted.host.querySelector(`[data-${attr}]`)?.getAttribute(`data-${attr}`);
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

  it("raises the overlay from the event even when the follow-up read fails", async () => {
    // The core has already fullscreened and pinned the window by the time the
    // event lands, so a failed `list_alarms` must not leave the user with a
    // takeover and nothing to dismiss it with.
    setCoreAlarms([scheduled("offline", Date.now())]);
    const probe = await mountProbe();

    failNextList = true;
    fireAlarm("offline");
    await settle();

    expect(probe.queue()).toBe("offline");
  });

  it("takes a snoozed alarm out of both lists and back in when it re-fires", async () => {
    setCoreAlarms([scheduled("snoozed", Date.now())]);
    const probe = await mountProbe();
    fireAlarm("snoozed");
    await settle();
    expect(probe.queue()).toBe("snoozed");

    await snoozeAlarm("snoozed", 5);
    await settle();
    expect(probe.queue()).toBe("");
    expect(probe.ringing()).toBe("");

    // Re-firing has to re-raise the takeover, not just re-list it: forgetting
    // the id on snooze is what keeps `firedThisRun` bounded, so the round trip
    // has to survive that.
    fireAlarm("snoozed");
    await settle();
    expect(probe.queue()).toBe("snoozed");
  });

  it("ignores a read that resolves after a newer one", async () => {
    setCoreAlarms([scheduled("racy", Date.now())]);
    const probe = await mountProbe();
    fireAlarm("racy");
    await settle();
    expect(probe.queue()).toBe("racy");

    // A poll issued while the alarm was still ringing, landing only after the
    // user dismissed it. Applying it would put the alarm back and re-raise the
    // takeover they just dismissed.
    delayNextListMs = 150;
    const stalePoll = refreshAlarms();
    await acknowledgeAlarm("racy");
    await settle();
    expect(probe.queue()).toBe("");
    expect(probe.ringing()).toBe("");

    await stalePoll;
    await settle();
    expect(probe.queue()).toBe("");
    expect(probe.ringing()).toBe("");
  });
});
