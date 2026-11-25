import { afterEach, describe, expect, it } from "bun:test";
import { waitFor } from "../test/render";
import type { Alarm } from "./alarms";
import {
  chimeAt,
  ESCALATE_AFTER_SECS,
  ringsNatively,
  syncBrowserAlarms,
} from "./browserAlarmRinger";

const alarm = (id: string, label: string, sound = true): Alarm => ({
  id,
  label,
  fireAtMs: Date.now(),
  sound,
  meetLink: null,
  status: "fired",
});

afterEach(() => syncBrowserAlarms([]));

describe("chimeAt", () => {
  it("gets louder and more frequent once the alarm has rung a minute", () => {
    const early = chimeAt(0);
    const late = chimeAt(ESCALATE_AFTER_SECS);
    expect(late.gain).toBeGreaterThan(early.gain);
    expect(late.gapMs).toBeLessThan(early.gapMs);
    expect(chimeAt(ESCALATE_AFTER_SECS - 1)).toEqual(early);
  });
});

describe("syncBrowserAlarms", () => {
  it("flashes the alarm in the tab title and puts the title back when the queue empties", async () => {
    document.title = "Yarvis";
    syncBrowserAlarms([alarm("a", "Standup")]);
    await waitFor(() => document.title === "⏰ Standup", "the title to flash");

    syncBrowserAlarms([]);
    expect(document.title).toBe("Yarvis");
  });
});

describe("ringsNatively", () => {
  it("is true in the macOS app's web view, which rings alarms itself", () => {
    const original = navigator.userAgent;
    Object.defineProperty(navigator, "userAgent", {
      value: `${original} YarvisMac`,
      configurable: true,
    });
    try {
      expect(ringsNatively()).toBe(true);
    } finally {
      Object.defineProperty(navigator, "userAgent", { value: original, configurable: true });
    }
    expect(ringsNatively()).toBe(false);
  });
});
