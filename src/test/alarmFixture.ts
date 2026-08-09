import type { Alarm } from "../lib/alarms";

/**
 * A stand-in for the Rust core's alarm state: the list `list_alarms` answers,
 * the commands that mutate it, and the `alarm-fired` event the scheduler emits.
 *
 * `mock.module` swaps a module for the whole run, so whichever alarm suite
 * installs its `@tauri-apps/api/core` stub last answers for every suite that
 * runs after it. Keeping the state here means all of those stubs read and write
 * the same core, so the surviving one still behaves correctly for all of them.
 */

/** Returned when the command isn't an alarm command, so callers can delegate. */
export const UNHANDLED = Symbol("unhandled");

let alarms: Alarm[] = [];
const firedListeners = new Set<(alarm: Alarm) => void>();

export function setCoreAlarms(next: Alarm[]): void {
  alarms = next;
}

/**
 * Clears the fake core. Call from an `afterAll` in every suite that writes to
 * it: this module and the `mock.module` stub reading it both live for the whole
 * run, so leftovers answer `list_alarms` for unrelated files that render alarm
 * or calendar components afterwards.
 */
export function resetCoreAlarms(): void {
  alarms = [];
  firedListeners.clear();
}

function setStatus(id: string, status: string): void {
  alarms = alarms.map((a) => (a.id === id ? { ...a, status } : a));
}

export function alarmInvoke(command: string, args: Record<string, unknown>): unknown {
  switch (command) {
    case "list_alarms":
      return alarms;
    case "create_alarm": {
      const alarm: Alarm = {
        id: `created-${alarms.length + 1}`,
        label: String(args.label ?? ""),
        fireAtMs: Number(args.fireAtMs ?? 0),
        sound: args.sound !== false,
        meetLink: (args.meetLink as string | null) ?? null,
        status: "scheduled",
      };
      alarms = [...alarms, alarm];
      return alarm;
    }
    case "acknowledge_alarm":
      setStatus(String(args.id), "acknowledged");
      return undefined;
    case "cancel_alarm":
      setStatus(String(args.id), "cancelled");
      return undefined;
    case "snooze_alarm":
      setStatus(String(args.id), "scheduled");
      return undefined;
    default:
      return UNHANDLED;
  }
}

/** Marks an alarm fired the way the scheduler does, then announces it. */
export function fireAlarm(id: string): void {
  setStatus(id, "fired");
  const alarm = alarms.find((a) => a.id === id);
  if (!alarm) throw new Error(`no such alarm: ${id}`);
  for (const listener of firedListeners) listener(alarm);
}

/** Stands in for `@tauri-apps/api/event`'s `listen`. */
export function alarmListen(event: string, handler: (e: { payload: Alarm }) => void): () => void {
  if (event !== "alarm-fired") return () => {};
  const listener = (alarm: Alarm) => handler({ payload: alarm });
  firedListeners.add(listener);
  return () => {
    firedListeners.delete(listener);
  };
}
