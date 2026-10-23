import type { Alarm } from "../lib/alarms";

/**
 * A stand-in for `src/lib/alarms`: the list the sidecar answers, the calls
 * that change it, and the `alarm-fired` event the core emits.
 *
 * `mock.module` swaps a module for the whole run, so whichever alarm suite
 * installs its stub last answers for every suite that runs after it. Keeping
 * the state here means all of those stubs read and write the same list, so
 * the surviving one still behaves correctly for all of them.
 */

let alarms: Alarm[] = [];
const firedListeners = new Set<(alarm: Alarm) => void>();

export function setAlarms(next: Alarm[]): void {
  alarms = next;
}

/**
 * Clears the fake. Call from an `afterAll` in every suite that writes to it:
 * this module and the `mock.module` stub reading it both live for the whole
 * run, so leftovers answer `listAlarms` for unrelated files that render alarm
 * or calendar components afterwards.
 */
export function resetAlarms(): void {
  alarms = [];
  firedListeners.clear();
}

function setStatus(id: string, status: string): Alarm {
  alarms = alarms.map((a) => (a.id === id ? { ...a, status } : a));
  const alarm = alarms.find((a) => a.id === id);
  if (!alarm) throw new Error(`no such alarm: ${id}`);
  return alarm;
}

/** The fake module, for `mock.module("…/lib/alarms", () => fakeAlarms)`. */
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
