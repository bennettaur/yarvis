import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Alarm } from "../lib/alarms";
import { alarmInvoke, alarmListen, setCoreAlarms, UNHANDLED } from "../test/alarmFixture";
import { nativeInvoke } from "../test/nativeInvoke";

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

// Torn down even when an expectation throws: a mount left behind keeps the
// alarm store subscribed, and the next test's first subscriber is the one that
// triggers the refresh it needs to see its own alarms.
let mounted: { root: ReturnType<typeof createRoot>; host: HTMLElement } | null = null;

afterEach(() => {
  mounted?.root.unmount();
  mounted?.host.remove();
  mounted = null;
});

async function mountPanel(): Promise<HTMLElement> {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  mounted = { root, host };
  root.render(createElement(AlarmsPanel));
  await settle();
  return host;
}

describe("AlarmsPanel", () => {
  it("lists both alarms that fired together, each with its own dismiss", async () => {
    setCoreAlarms([fired("page-a", "Morning coffee"), fired("page-b", "Retro")]);
    const host = await mountPanel();

    expect(host.innerHTML).toContain("Going off now (2)");
    expect(host.innerHTML).toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");

    const dismiss = Array.from(host.querySelectorAll("button")).filter(
      (b) => b.textContent === "Dismiss",
    );
    expect(dismiss).toHaveLength(2);

    dismiss[0]?.click();
    await settle();

    // Dismissing the first leaves the second listed and still dismissable.
    expect(host.innerHTML).toContain("Going off now (1)");
    expect(host.innerHTML).not.toContain("Morning coffee");
    expect(host.innerHTML).toContain("Retro");
  });

  it("hides the going-off section when nothing has fired", async () => {
    setCoreAlarms([{ ...fired("upcoming", "Later"), status: "scheduled" }]);
    const host = await mountPanel();

    expect(host.innerHTML).not.toContain("Going off now");
    expect(host.innerHTML).toContain("Upcoming (1)");
  });
});
