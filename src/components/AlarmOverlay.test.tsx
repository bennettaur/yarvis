import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../lib/alarms";
import { renderToHtml } from "../test/render";

/**
 * Verifies the takeover's meeting affordance: a "Join meeting" button appears
 * only when the alarm carries a meet link, and clicking it both opens the link
 * and ends the alarm (acknowledge).
 */

const opened: string[] = [];
const invoked: Array<{ command: string; args: unknown }> = [];

mock.module("@tauri-apps/plugin-opener", () => ({
  openUrl: async (url: string) => {
    opened.push(url);
  },
}));

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args: unknown) => {
    invoked.push({ command, args });
    return command === "list_alarms" ? [] : undefined;
  },
}));

const AlarmOverlay = (await import("./AlarmOverlay")).default;

const baseAlarm: Alarm = {
  id: "a1",
  label: "Meeting: Standup",
  fireAtMs: Date.now(),
  sound: true,
  meetLink: null,
  status: "fired",
};

describe("AlarmOverlay", () => {
  beforeEach(() => {
    opened.length = 0;
    invoked.length = 0;
  });

  it("shows a Join meeting button for meeting alarms", async () => {
    const html = await renderToHtml(
      createElement(AlarmOverlay, {
        alarm: { ...baseAlarm, meetLink: "https://meet.google.com/abc" },
        onDone: () => {},
      }),
    );
    expect(html).toContain("Join meeting");
  });

  it("omits the Join meeting button when there is no meet link", async () => {
    const html = await renderToHtml(
      createElement(AlarmOverlay, { alarm: baseAlarm, onDone: () => {} }),
    );
    expect(html).not.toContain("Join meeting");
  });

  it("opens the link and ends the alarm when Join meeting is clicked", async () => {
    let done = false;

    // Mounted by hand rather than via renderToHtml: the click has to happen
    // between render and reading effects, and renderToHtml only returns a
    // static HTML string with no live handle to dispatch the click on.
    const host = document.createElement("div");
    document.body.appendChild(host);
    const { createRoot } = await import("react-dom/client");
    const root = createRoot(host);
    root.render(
      createElement(AlarmOverlay, {
        alarm: { ...baseAlarm, meetLink: "https://meet.google.com/abc" },
        onDone: () => {
          done = true;
        },
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 50));

    const joinButton = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Join meeting",
    );
    expect(joinButton).toBeDefined();
    joinButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(opened).toEqual(["https://meet.google.com/abc"]);
    expect(invoked).toContainEqual({ command: "acknowledge_alarm", args: { id: "a1" } });
    expect(done).toBe(true);

    root.unmount();
    host.remove();
  });
});
