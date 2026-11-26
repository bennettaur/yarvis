import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { waitFor } from "../test/render";
import type { Alarm } from "./alarms";
import {
  chimeAt,
  ESCALATE_AFTER_SECS,
  primeAlarmAudio,
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
  it("flashes the front alarm in the tab title and puts the title back when the queue empties", async () => {
    document.title = "Yarvis";
    syncBrowserAlarms([alarm("a", "Standup")]);
    await waitFor(() => document.title === "⏰ Standup", "the title to flash");

    syncBrowserAlarms([alarm("b", "Retro")]);
    await waitFor(() => document.title === "⏰ Retro", "the title to show the next alarm");

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
    // The test preload runs outside Tauri, so nothing native rings here.
    expect(ringsNatively()).toBe(false);
  });
});

/** Records the notifications shown, with a permission each test sets. */
class FakeNotification {
  static permission: NotificationPermission = "granted";
  static shown: string[] = [];
  static requested = 0;
  static async requestPermission(): Promise<NotificationPermission> {
    FakeNotification.requested += 1;
    return FakeNotification.permission;
  }
  onclick: (() => void) | null = null;
  constructor(_title: string, options: { body: string }) {
    FakeNotification.shown.push(options.body);
  }
  close(): void {}
}

/** Counts the tones played; always unlocked. */
class FakeAudioContext {
  static tones = 0;
  state = "running";
  currentTime = 0;
  destination = {};
  createOscillator() {
    FakeAudioContext.tones += 1;
    return {
      type: "",
      frequency: { value: 0 },
      connect: (node: unknown) => node,
      start() {},
      stop() {},
    };
  }
  createGain() {
    const ramp = () => {};
    return {
      gain: {
        setValueAtTime: ramp,
        linearRampToValueAtTime: ramp,
        exponentialRampToValueAtTime: ramp,
      },
      connect: (node: unknown) => node,
    };
  }
  resume() {}
}

const realNotification = (globalThis as Record<string, unknown>).Notification;
const realAudioContext = (globalThis as Record<string, unknown>).AudioContext;
(globalThis as Record<string, unknown>).Notification = FakeNotification;
(globalThis as Record<string, unknown>).AudioContext = FakeAudioContext;
afterAll(() => {
  (globalThis as Record<string, unknown>).Notification = realNotification;
  (globalThis as Record<string, unknown>).AudioContext = realAudioContext;
});

beforeEach(() => {
  FakeNotification.permission = "granted";
  FakeNotification.shown = [];
  FakeNotification.requested = 0;
  FakeAudioContext.tones = 0;
});

describe("the first click in the tab", () => {
  it("unlocks sound and asks once for notifications", () => {
    FakeNotification.permission = "default";
    primeAlarmAudio();
    window.dispatchEvent(new Event("pointerdown"));
    window.dispatchEvent(new Event("pointerdown"));
    expect(FakeNotification.requested).toBe(1);

    FakeNotification.permission = "granted";
    syncBrowserAlarms([alarm("loud", "Standup")]);
    // Two tones per chime.
    expect(FakeAudioContext.tones).toBe(2);
  });
});

describe("chiming", () => {
  // Relies on the click above having unlocked the fake audio context.
  it("stays quiet for alarms with sound off, and starts when one with sound joins", () => {
    syncBrowserAlarms([alarm("quiet", "Focus", false)]);
    expect(FakeAudioContext.tones).toBe(0);

    syncBrowserAlarms([alarm("quiet", "Focus", false), alarm("loud", "Standup")]);
    expect(FakeAudioContext.tones).toBe(2);
  });
});

describe("notifications", () => {
  it("shows one per alarm however often the queue is synced, and again after it rings anew", () => {
    const standup = alarm("n-a", "Standup");
    syncBrowserAlarms([standup]);
    syncBrowserAlarms([standup, alarm("n-b", "Retro")]);
    syncBrowserAlarms([standup, alarm("n-b", "Retro")]);
    expect(FakeNotification.shown).toEqual(["Standup", "Retro"]);

    syncBrowserAlarms([]);
    syncBrowserAlarms([standup]);
    expect(FakeNotification.shown).toEqual(["Standup", "Retro", "Standup"]);
  });

  it("shows nothing when notifications aren't allowed", () => {
    FakeNotification.permission = "denied";
    syncBrowserAlarms([alarm("n-c", "Standup")]);
    expect(FakeNotification.shown).toEqual([]);
  });
});
