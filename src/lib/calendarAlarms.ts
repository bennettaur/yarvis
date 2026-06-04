import { useCallback, useSyncExternalStore } from "react";
import { type Alarm, createAlarm, listAlarms, onAlarmFired } from "./alarms";
import type { CalendarEvent } from "./calendar";
import { startMs } from "./calendarGrid";

/**
 * Shared logic for arming alarms on calendar events and detecting alarms that
 * are already set. Lifted out of CalendarPanel so every calendar view (agenda,
 * week, month, day) arms events and reports "already set" the same way.
 */

// Fire the meeting alarm shortly before the start. The alarm system then
// escalates ~60s later (around the meeting start) if it isn't acknowledged.
export const LEAD_MINUTES = 1;

/** Only timed events that haven't started yet can be armed. */
export function isArmable(event: CalendarEvent): boolean {
  if (event.allDay) return false;
  const ms = startMs(event);
  return ms !== null && ms > Date.now();
}

/** The alarm label used for an event, also the key for recognizing it later. */
export function alarmLabel(event: CalendarEvent): string {
  return `Meeting: ${event.title}`;
}

/** When an event's alarm should fire (ms epoch), or null if start is unknown. */
function fireAtFor(event: CalendarEvent): number | null {
  const ms = startMs(event);
  return ms === null ? null : ms - LEAD_MINUTES * 60_000;
}

/** Matches scheduled alarms to an event by label and a near-equal fire time. */
const FIRE_TOLERANCE_MS = 90_000;

function findArmed(event: CalendarEvent, alarms: Alarm[]): Alarm | null {
  const fireAt = fireAtFor(event);
  if (fireAt === null) return null;
  const label = alarmLabel(event);
  return (
    alarms.find(
      (a) =>
        a.status === "scheduled" &&
        a.label === label &&
        Math.abs(a.fireAtMs - fireAt) < FIRE_TOLERANCE_MS,
    ) ?? null
  );
}

/**
 * Shared scheduled-alarm list backing every calendar view. A single poll +
 * `alarm-fired` listener feeds all subscribers, so placing several calendar
 * widgets (e.g. in an Omni layout) doesn't multiply the IPC traffic. The list
 * reference only changes when the alarms actually change, which keeps
 * `useSyncExternalStore` snapshots stable between ticks.
 */
let alarmsSnapshot: Alarm[] = [];
const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let unlistenFired: (() => void) | undefined;

async function refreshAlarms(): Promise<void> {
  try {
    alarmsSnapshot = await listAlarms();
    for (const notify of listeners) notify();
  } catch {
    // Leave the last known list in place; the periodic refresh will retry.
  }
}

/** Subscribes to the shared store, starting the poll for the first subscriber. */
function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  if (listeners.size === 1) {
    void refreshAlarms();
    pollTimer = setInterval(() => void refreshAlarms(), 30_000);
    onAlarmFired(() => void refreshAlarms()).then((u) => {
      unlistenFired = u;
    });
  }
  return () => {
    listeners.delete(notify);
    if (listeners.size === 0) {
      clearInterval(pollTimer);
      pollTimer = undefined;
      unlistenFired?.();
      unlistenFired = undefined;
    }
  };
}

/**
 * Exposes per-event arming + "already set" detection, backed by the shared
 * alarm store so "alarm set" reflects the real alarm list (and survives
 * reloads) rather than transient local state.
 */
export function useEventAlarms() {
  const alarms = useSyncExternalStore(subscribe, () => alarmsSnapshot);

  const isArmed = useCallback(
    (event: CalendarEvent) => findArmed(event, alarms) !== null,
    [alarms],
  );

  const arm = useCallback(
    async (event: CalendarEvent) => {
      const fireAt = fireAtFor(event);
      if (fireAt === null || !isArmable(event)) return;
      if (findArmed(event, alarms)) return;
      await createAlarm(alarmLabel(event), fireAt);
      await refreshAlarms();
    },
    [alarms],
  );

  return { isArmed, arm, refresh: refreshAlarms };
}
