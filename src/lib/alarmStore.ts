import { useSyncExternalStore } from "react";
import {
  type Alarm,
  acknowledgeAlarm as invokeAcknowledge,
  cancelAlarm as invokeCancel,
  createAlarm as invokeCreate,
  snoozeAlarm as invokeSnooze,
  listAlarms,
  onAlarmFired,
} from "./alarms";

/**
 * Shared live view of the Rust core's alarm list. The core owns alarm state; a
 * single poll plus an `alarm-fired` listener feeds every subscriber, so the
 * alarms page, the attention panel, the takeover overlay, and any number of
 * calendar widgets all read the same list without multiplying IPC traffic.
 *
 * Mutations go through here rather than `lib/alarms` directly so the list
 * refreshes as soon as the user acts, instead of on the next poll.
 */

const POLL_MS = 30_000;

let alarms: Alarm[] = [];
/** Fired and not yet dealt with, oldest first. */
let ringing: Alarm[] = [];
/** The subset of `ringing` this app run watched fire, oldest first. */
let takeover: Alarm[] = [];

/**
 * Ids whose `alarm-fired` event arrived during this app run. An alarm left in
 * the "fired" state by a previous run is still worth listing (nobody ever
 * dismissed it) but must not throw up a full-screen takeover on launch, so only
 * this run's firings drive the overlay.
 */
const firedThisRun = new Set<string>();

const listeners = new Set<() => void>();
let pollTimer: ReturnType<typeof setInterval> | undefined;
let unlistenFired: (() => void) | undefined;

/** Identity of the list as far as any consumer is concerned. */
function fingerprint(list: Alarm[]): string {
  return list.map((a) => `${a.id}:${a.status}:${a.fireAtMs}`).join("|");
}

function sameIds(a: Alarm[], b: Alarm[]): boolean {
  return a.length === b.length && a.every((alarm, i) => alarm.id === b[i].id);
}

/**
 * Rebuilds the derived lists, keeping the previous array reference when nothing
 * changed. `useSyncExternalStore` re-renders on every snapshot identity change,
 * so handing back a fresh array would re-render every consumer on every poll.
 */
function recomputeDerived(): boolean {
  const nextRinging = alarms
    .filter((a) => a.status === "fired")
    .sort((a, b) => a.fireAtMs - b.fireAtMs);
  const nextTakeover = nextRinging.filter((a) => firedThisRun.has(a.id));

  let changed = false;
  if (!sameIds(ringing, nextRinging)) {
    ringing = nextRinging;
    changed = true;
  }
  if (!sameIds(takeover, nextTakeover)) {
    takeover = nextTakeover;
    changed = true;
  }
  return changed;
}

function apply(next: Alarm[]): void {
  const listChanged = fingerprint(next) !== fingerprint(alarms);
  if (listChanged) alarms = next;
  const derivedChanged = recomputeDerived();
  if (listChanged || derivedChanged) {
    for (const notify of listeners) notify();
  }
}

export async function refreshAlarms(): Promise<void> {
  try {
    apply(await listAlarms());
  } catch {
    // Leave the last known list in place; the periodic refresh will retry.
  }
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  if (listeners.size === 1) {
    void refreshAlarms();
    pollTimer = setInterval(() => void refreshAlarms(), POLL_MS);
    onAlarmFired((alarm) => {
      firedThisRun.add(alarm.id);
      // The event carries the alarm, but the core is the source of truth for
      // the rest of the list, so re-read rather than splice it in locally.
      void refreshAlarms();
    }).then((u) => {
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

/** Every alarm the core knows about, in creation order. */
export function useAlarms(): Alarm[] {
  return useSyncExternalStore(subscribe, () => alarms);
}

/**
 * Alarms that have fired and nobody has acknowledged, snoozed, or cancelled —
 * the ones the user still needs to deal with, oldest first.
 */
export function useRingingAlarms(): Alarm[] {
  return useSyncExternalStore(subscribe, () => ringing);
}

/**
 * The queue behind the full-screen takeover. Several alarms set for the same
 * time all fire in one scheduler tick, so the overlay works through them one at
 * a time rather than only ever showing whichever event landed last.
 */
export function useAlarmTakeoverQueue(): Alarm[] {
  return useSyncExternalStore(subscribe, () => takeover);
}

export async function createAlarm(
  label: string,
  fireAtMs: number,
  sound = true,
  meetLink: string | null = null,
): Promise<Alarm> {
  const alarm = await invokeCreate(label, fireAtMs, sound, meetLink);
  await refreshAlarms();
  return alarm;
}

export async function acknowledgeAlarm(id: string): Promise<void> {
  await invokeAcknowledge(id);
  await refreshAlarms();
}

export async function snoozeAlarm(id: string, minutes: number): Promise<void> {
  await invokeSnooze(id, minutes);
  await refreshAlarms();
}

export async function cancelAlarm(id: string): Promise<void> {
  await invokeCancel(id);
  await refreshAlarms();
}
