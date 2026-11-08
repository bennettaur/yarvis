import { mock } from "bun:test";
import type { Alarm } from "../lib/alarms";
import { passThrough } from "./passThrough";

/**
 * A stand-in for `src/lib/alarms`: the list the sidecar answers, the calls
 * that change it, and the `alarm-fired` event the core emits.
 *
 * A suite puts it in place with `stubAlarmsApi`, and `resetAlarms` clears it,
 * so `lib/alarms` is registered once here (see `passThrough.ts`) and every
 * other file sees the real module.
 */

let alarms: Alarm[] = [];
const firedListeners = new Set<(alarm: Alarm) => void>();

export function setAlarms(next: Alarm[]): void {
  alarms = next;
}

/**
 * Clears the fake and takes it out of `lib/alarms`. Call from an `afterAll` in
 * every suite that stubs it: this module lives for the whole run, so leftovers
 * would answer for unrelated files that render alarm or calendar components
 * afterwards.
 */
export function resetAlarms(): void {
  alarms = [];
  firedListeners.clear();
  alarmsModule.reset();
}

function setStatus(id: string, status: string): Alarm {
  alarms = alarms.map((a) => (a.id === id ? { ...a, status } : a));
  const alarm = alarms.find((a) => a.id === id);
  if (!alarm) throw new Error(`no such alarm: ${id}`);
  return alarm;
}

/** The fake `lib/alarms`, which `stubAlarmsApi` puts in place. */
export const fakeAlarms = {
  listAlarms: async (): Promise<Alarm[]> => alarms,
  createAlarm: async (
    label: string,
    fireAtMs: number,
    sound = true,
    meetLink: string | null = null,
  ): Promise<Alarm> => {
    const alarm: Alarm = {
      id: `created-${alarms.length + 1}`,
      label,
      fireAtMs,
      sound,
      meetLink,
      status: "scheduled",
    };
    alarms = [...alarms, alarm];
    return alarm;
  },
  acknowledgeAlarm: async (id: string) => setStatus(id, "acknowledged"),
  cancelAlarm: async (id: string) => setStatus(id, "cancelled"),
  snoozeAlarm: async (id: string, _minutes: number) => setStatus(id, "scheduled"),
  onAlarmFired: async (cb: (alarm: Alarm) => void) => {
    firedListeners.add(cb);
    return () => {
      firedListeners.delete(cb);
    };
  },
  // Tests change the list through this fake, never behind the store's back.
  followAlarmChanges: (_onChange: () => void) => () => {},
};

/** Marks an alarm fired the way the sidecar does, then announces it the way the core does. */
export function fireAlarm(id: string): void {
  const alarm = setStatus(id, "fired");
  for (const listener of firedListeners) listener(alarm);
}

const alarmsModule = passThrough({ ...(await import("../lib/alarms")) });
mock.module("../lib/alarms", () => alarmsModule.module);

/** Answers `lib/alarms` from the fake, with `extra` replacing parts of it. */
export function stubAlarmsApi(extra: Partial<typeof alarmsModule.module> = {}): void {
  alarmsModule.stub({ ...fakeAlarms, ...extra });
}
