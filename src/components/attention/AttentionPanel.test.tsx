import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../../lib/alarms";
import {
  alarmInvoke,
  alarmListen,
  resetCoreAlarms,
  setCoreAlarms,
  UNHANDLED,
} from "../../test/alarmFixture";
import { nativeInvoke } from "../../test/nativeInvoke";
import { mountForInteraction } from "../../test/render";

/**
 * Covers the alarm half of the attention panel (issue #201's "add something to
 * the attention stream"). Alarms live in the Rust core rather than the sidecar's
 * attention table, so the Ringing section is fed by the alarm store — this pins
 * that it lists every unhandled alarm and dismisses them one at a time.
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

const AttentionPanel = (await import("./AttentionPanel")).default;

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
let openedAlarms = 0;

afterEach(() => {
  unmount?.();
  unmount = null;
  openedAlarms = 0;
});

afterAll(resetCoreAlarms);

async function mountPanel(): Promise<HTMLElement> {
  const mounted = await mountForInteraction(
    createElement(AttentionPanel, {
      open: true,
      onClose: () => {},
      onOpenAttention: () => {},
      wip: [],
      wipLoading: false,
      onOpenWip: () => {},
      onOpenAlarms: () => {
        openedAlarms += 1;
      },
    }),
    50,
  );
  unmount = mounted.unmount;
  return mounted.host;
}

describe("AttentionPanel ringing alarms", () => {
  it("lists every unhandled alarm and dismisses them one at a time", async () => {
    setCoreAlarms([fired("att-a", "Morning coffee"), fired("att-b", "Retro")]);
    const host = await mountPanel();

    expect(host.innerHTML).toContain("Ringing");
    expect(host.innerHTML).toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");

    const dismiss = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.textContent === "Dismiss",
    );
    expect(dismiss).toHaveLength(2);

    dismiss[0]?.click();
    await settle();

    expect(host.innerHTML).not.toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");
  });

  it("sends the user to the alarms page when a row is clicked", async () => {
    setCoreAlarms([fired("att-open", "Standup")]);
    const host = await mountPanel();

    const row = Array.from(host.querySelectorAll("button")).find((b) =>
      b.textContent?.includes("Standup"),
    );
    expect(row).toBeDefined();
    row?.click();
    await settle();

    expect(openedAlarms).toBe(1);
  });

  it("omits the ringing section entirely when nothing has fired", async () => {
    setCoreAlarms([{ ...fired("quiet", "Later"), status: "scheduled" }]);
    const host = await mountPanel();

    expect(host.innerHTML).not.toContain("Ringing");
    expect(host.innerHTML).toContain("Needs you now");
  });
});
