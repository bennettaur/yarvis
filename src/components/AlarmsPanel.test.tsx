import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../lib/alarms";
import {
  alarmInvoke,
  alarmListen,
  resetCoreAlarms,
  setCoreAlarms,
  UNHANDLED,
} from "../test/alarmFixture";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction } from "../test/render";

/**
 * The alarms page is the fallback for issue #201: whatever the full-screen
 * takeover is showing, every alarm that has fired and gone undismissed is
 * listed here with its own dismiss action.
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

const AlarmsPanel = (await import("./AlarmsPanel")).default;

const fired = (id: string, label: string): Alarm => ({
  id,
  label,
  fireAtMs: Date.now(),
  sound: true,
  meetLink: null,
  status: "fired",
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

afterAll(resetCoreAlarms);

async function mountPanel(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(createElement(AlarmsPanel), 50);
  unmount = mounted.unmount;
  return mounted.host;
}

describe("AlarmsPanel", () => {
  it("lists both alarms that fired together, each with its own dismiss", async () => {
    setCoreAlarms([fired("page-a", "Morning coffee"), fired("page-b", "Retro")]);
    const host = await mountPanel();

    expect(host.innerHTML).toContain("Ringing (2)");
    expect(host.innerHTML).toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");

    const dismiss = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.textContent === "Dismiss",
    );
    expect(dismiss).toHaveLength(2);

    dismiss[0]?.click();
    await settle();

    // Dismissing the first leaves the second listed and still dismissable.
    expect(host.innerHTML).toContain("Ringing (1)");
    expect(host.innerHTML).not.toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");
  });

  it("hides the ringing section when nothing has fired", async () => {
    setCoreAlarms([{ ...fired("upcoming", "Later"), status: "scheduled" }]);
    const host = await mountPanel();

    expect(host.innerHTML).not.toContain("Ringing (");
    expect(host.innerHTML).toContain("Upcoming (1)");
  });
});
