import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../lib/alarms";
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

/**
 * The regression test for issue #201, at the level the bug actually lived: the
 * app used to hold a single "active alarm", so of two alarms firing in one
 * scheduler tick only the last was reachable and dismissing it stranded the
 * other. Asserting through the rendered takeover covers the queue, the
 * remount-per-alarm key, and the waiting count in one pass.
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

const AlarmTakeover = (await import("./AlarmTakeover")).default;

const scheduled = (id: string, label: string, fireAtMs: number): Alarm => ({
  id,
  label,
  fireAtMs,
  sound: true,
  meetLink: null,
  status: "scheduled",
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

afterAll(resetCoreAlarms);

async function mountTakeover(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(createElement(AlarmTakeover), 50);
  unmount = mounted.unmount;
  return mounted.host;
}

const clickButton = async (host: HTMLElement, text: string) => {
  const button = Array.from(host.querySelectorAll("button")).find((b) => b.textContent === text);
  expect(button).toBeDefined();
  button?.click();
  await settle();
};

describe("AlarmTakeover", () => {
  it("works through every alarm that fired in the same tick", async () => {
    const at = Date.now();
    setCoreAlarms([scheduled("tick-a", "Standup", at), scheduled("tick-b", "Retro", at)]);
    const host = await mountTakeover();

    fireAlarm("tick-a");
    fireAlarm("tick-b");
    await settle();

    expect(host.innerHTML).toContain("Standup");
    expect(host.innerHTML).toContain("1 more alarm waiting behind this one");

    await clickButton(host, "Acknowledge");

    // The second alarm takes the screen instead of the takeover vanishing with
    // it still ringing and unreachable — the whole of issue #201.
    expect(host.innerHTML).toContain("Retro");
    expect(host.innerHTML).not.toContain("Standup");
    expect(host.innerHTML).not.toContain("waiting behind");

    await clickButton(host, "Acknowledge");
    expect(host.innerHTML).toBe("");
  });

  it("stays out of the way for an alarm left firing by a previous run", async () => {
    setCoreAlarms([
      { ...scheduled("left-over", "Yesterday", Date.now() - 86_400_000), status: "fired" },
    ]);
    const host = await mountTakeover();

    // Listed on the alarms page, but launching the app must not throw up a
    // full-screen takeover for an alarm that fired before this run started.
    expect(host.innerHTML).toBe("");
  });

  it("hands the screen back to the next alarm when one is snoozed", async () => {
    const at = Date.now();
    setCoreAlarms([scheduled("snooze-a", "First", at), scheduled("snooze-b", "Second", at)]);
    const host = await mountTakeover();

    fireAlarm("snooze-a");
    fireAlarm("snooze-b");
    await settle();
    expect(host.innerHTML).toContain("First");

    await clickButton(host, "Snooze 5 min");

    expect(host.innerHTML).toContain("Second");
    expect(host.innerHTML).not.toContain("First");
  });
});
