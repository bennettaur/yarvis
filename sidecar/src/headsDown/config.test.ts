import { afterAll, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chooseSleep,
  DEFAULT_HEADS_DOWN_CONFIG,
  disableAlwaysOn,
  getHeadsDownConfig,
  isNightShift,
  isWithinWorkingHours,
  saveHeadsDownConfig,
} from "./config.ts";

const officeHours = { days: [1, 2, 3, 4, 5], start: "09:00", end: "17:00" };
const nights = { days: [1, 2, 3, 4, 5], start: "20:00", end: "02:00" };

// Local times; the test setup pins the timezone. 2026-10-19 is a Monday.
const at = (iso: string) => new Date(iso);

describe("isWithinWorkingHours", () => {
  it("is within office hours on a weekday afternoon, and not after five or at the weekend", () => {
    expect(isWithinWorkingHours(at("2026-10-19T14:00:00"), officeHours)).toBe(true);
    expect(isWithinWorkingHours(at("2026-10-19T17:00:00"), officeHours)).toBe(false);
    expect(isWithinWorkingHours(at("2026-10-18T14:00:00"), officeHours)).toBe(false);
  });

  it("counts the early hours of an overnight shift as the day it started", () => {
    expect(isWithinWorkingHours(at("2026-10-19T23:00:00"), nights)).toBe(true);
    expect(isWithinWorkingHours(at("2026-10-20T01:30:00"), nights)).toBe(true);
    // Saturday 01:30 is still Friday's shift; Monday 01:30 follows a Sunday off.
    expect(isWithinWorkingHours(at("2026-10-24T01:30:00"), nights)).toBe(true);
    expect(isWithinWorkingHours(at("2026-10-19T01:30:00"), nights)).toBe(false);
  });

  it("is always within working hours when none are set", () => {
    expect(isWithinWorkingHours(at("2026-10-18T03:00:00"), null)).toBe(true);
  });
});

describe("chooseSleep", () => {
  const busy = { withinWorkingHours: true, openStreams: 2, allWaiting: false, userAway: false };

  it("takes what the pass asked for, within the configured bounds", () => {
    expect(chooseSleep({ ...busy, requestedMinutes: 10 }, DEFAULT_HEADS_DOWN_CONFIG).minutes).toBe(
      10,
    );
    expect(chooseSleep({ ...busy, requestedMinutes: 1 }, DEFAULT_HEADS_DOWN_CONFIG).minutes).toBe(
      5,
    );
    expect(chooseSleep({ ...busy, requestedMinutes: 600 }, DEFAULT_HEADS_DOWN_CONFIG).minutes).toBe(
      120,
    );
  });

  it("sleeps at least the idle time when there is little to do, and says why", () => {
    const sleep = chooseSleep(
      {
        requestedMinutes: 5,
        withinWorkingHours: false,
        openStreams: 2,
        allWaiting: true,
        userAway: false,
      },
      DEFAULT_HEADS_DOWN_CONFIG,
    );
    expect(sleep.minutes).toBe(60);
    expect(sleep.reason).toBe("outside working hours, every stream is waiting");
  });

  it("uses the shortest sleep when the pass asked for nothing and there is work", () => {
    expect(chooseSleep({ ...busy, requestedMinutes: null }, DEFAULT_HEADS_DOWN_CONFIG)).toEqual({
      minutes: 5,
      reason: "work to push",
    });
  });

  it("says there is nothing to push when no stream is open", () => {
    const sleep = chooseSleep(
      { ...busy, openStreams: 0, allWaiting: true, requestedMinutes: null },
      DEFAULT_HEADS_DOWN_CONFIG,
    );
    expect(sleep).toEqual({ minutes: 60, reason: "nothing to push" });
  });
});

describe("isNightShift", () => {
  const shift = { start: "23:00", end: "07:00" };

  it("covers the hours every day, past midnight included", () => {
    expect(isNightShift(at("2026-10-18T23:30:00"), shift)).toBe(true);
    expect(isNightShift(at("2026-10-24T03:00:00"), shift)).toBe(true);
    expect(isNightShift(at("2026-10-19T07:00:00"), shift)).toBe(false);
    expect(isNightShift(at("2026-10-19T14:00:00"), shift)).toBe(false);
  });

  it("is never night shift when none is set", () => {
    expect(isNightShift(at("2026-10-19T03:00:00"), null)).toBe(false);
  });
});

describe("chooseSleep at night", () => {
  it("sleeps at least the night-shift sleep, and says why", () => {
    const sleep = chooseSleep(
      {
        requestedMinutes: 5,
        withinWorkingHours: true,
        openStreams: 2,
        allWaiting: false,
        userAway: false,
        duringNightShift: true,
      },
      { ...DEFAULT_HEADS_DOWN_CONFIG, nightShiftMinSleepMinutes: 90 },
    );
    expect(sleep).toEqual({ minutes: 90, reason: "night shift" });
  });
});

describe("getHeadsDownConfig", () => {
  const dir = mkdtempSync(join(tmpdir(), "heads-down-config-"));
  const originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
    process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  });

  const storedTimeout = async (passTimeoutMinutes: unknown) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ headsDown: { passTimeoutMinutes } }));
    process.env.YARVIS_SETTINGS_PATH = path;
    return (await getHeadsDownConfig()).passTimeoutMinutes;
  };

  it("falls back to the default pass timeout for a nonsensical stored value, and caps a huge one at four hours", async () => {
    expect(await storedTimeout(90)).toBe(90);
    for (const bad of ["90", 0, -5, null]) expect(await storedTimeout(bad)).toBe(20);
    expect(await storedTimeout(10_000)).toBe(240);
  });

  const storedRoutines = async (maxRoutinesPerPass: unknown) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ headsDown: { maxRoutinesPerPass } }));
    process.env.YARVIS_SETTINGS_PATH = path;
    return (await getHeadsDownConfig()).maxRoutinesPerPass;
  };

  it("keeps a hand-edited routines-per-pass within what the page allows", async () => {
    expect(await storedRoutines(0)).toBe(0);
    expect(await storedRoutines(4)).toBe(4);
    expect(await storedRoutines(50)).toBe(10);
    for (const bad of ["3", -1, 1.5, null]) expect(await storedRoutines(bad)).toBe(2);
  });

  const stored = async (headsDown: unknown) => {
    const path = join(dir, "settings.json");
    writeFileSync(path, JSON.stringify({ headsDown }));
    process.env.YARVIS_SETTINGS_PATH = path;
    return getHeadsDownConfig();
  };

  it("leaves always-on, night shift and the pass limit off unless they are set", async () => {
    const config = await stored({});
    expect(config).toMatchObject({ alwaysOn: false, nightShift: null, maxPassesPerDay: null });
  });

  it("drops a hand-edited night shift or pass limit it can't use", async () => {
    expect((await stored({ nightShift: { start: "25:00", end: "07:00" } })).nightShift).toBeNull();
    expect((await stored({ nightShift: { start: "23:00", end: "07:00" } })).nightShift).toEqual({
      start: "23:00",
      end: "07:00",
    });
    for (const bad of [0, -3, 2.5, "50"]) {
      expect((await stored({ maxPassesPerDay: bad })).maxPassesPerDay).toBeNull();
    }
    expect((await stored({ maxPassesPerDay: 40 })).maxPassesPerDay).toBe(40);
  });

  it("turns always-on off and keeps the rest", async () => {
    await stored({});
    await saveHeadsDownConfig({
      ...DEFAULT_HEADS_DOWN_CONFIG,
      alwaysOn: true,
      guidance: "be nice",
    });
    await disableAlwaysOn();
    expect(await getHeadsDownConfig()).toMatchObject({ alwaysOn: false, guidance: "be nice" });
  });
});
