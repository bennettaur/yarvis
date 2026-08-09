import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { Alarm } from "../lib/alarms";
import { nativeInvoke } from "../test/nativeInvoke";
import { mountForInteraction, renderToHtml } from "../test/render";

/**
 * Verifies the takeover's meeting affordance: a "Join meeting" button appears
 * only when the alarm carries a meet link, and clicking it both opens the link
 * and ends the alarm (acknowledge). Also covers the queue hint that tells the
 * user other alarms are waiting behind this one (issue #201).
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
    return nativeInvoke(command);
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
        remaining: 0,
      }),
    );
    expect(html).toContain("Join meeting");
  });

  it("omits the Join meeting button when there is no meet link", async () => {
    const html = await renderToHtml(
      createElement(AlarmOverlay, { alarm: baseAlarm, remaining: 0 }),
    );
    expect(html).not.toContain("Join meeting");
  });

  it("says how many alarms are waiting behind this one", async () => {
    const html = await renderToHtml(
      createElement(AlarmOverlay, { alarm: baseAlarm, remaining: 2 }),
    );
    expect(html).toContain("2 more alarms waiting behind this one");
  });

  it("says nothing about a queue when this is the only alarm", async () => {
    const html = await renderToHtml(
      createElement(AlarmOverlay, { alarm: baseAlarm, remaining: 0 }),
    );
    expect(html).not.toContain("waiting behind");
  });

  it("opens the link and ends the alarm when Join meeting is clicked", async () => {
    // Mounted live rather than via renderToHtml: the click needs a real handle
    // to dispatch on, which a static HTML string can't give.
    const { host, unmount } = await mountForInteraction(
      createElement(AlarmOverlay, {
        alarm: { ...baseAlarm, meetLink: "https://meet.google.com/abc" },
        remaining: 0,
      }),
      50,
    );

    const joinButton = Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === "Join meeting",
    );
    expect(joinButton).toBeDefined();
    joinButton?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(opened).toEqual(["https://meet.google.com/abc"]);
    expect(invoked).toContainEqual({ command: "acknowledge_alarm", args: { id: "a1" } });

    unmount();
  });
});
