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
let takeoverQueue: Alarm[] = [];

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

/**
 * Whole-list identity. Every field an alarm carries is rendered somewhere, so
 * comparing all of them means a change the core makes can't be swallowed — a
 * narrower key would silently strand consumers on a stale array.
 */
function fingerprint(list: Alarm[]): string {
  return JSON.stringify(list);
}

/** Forgets ids the core no longer reports as firing, so the set stays bounded. */
function pruneFiredThisRun(): void {
  if (firedThisRun.size === 0) return;
  const stillFiring = new Set(alarms.filter((a) => a.status === "fired").map((a) => a.id));
  for (const id of firedThisRun) {
    if (!stillFiring.has(id)) firedThisRun.delete(id);
  }
}

/**
 * Rebuilds the derived lists, keeping the previous array reference when nothing
 * changed, and reports whether either moved. `useSyncExternalStore` re-renders
 * on every snapshot identity change, so handing back a fresh array would
 * re-render every consumer on every poll.
 */
function recomputeDerived(): boolean {
  const nextRinging = alarms
    .filter((a) => a.status === "fired")
    .sort((a, b) => a.fireAtMs - b.fireAtMs);
  const nextQueue = nextRinging.filter((a) => firedThisRun.has(a.id));

  let changed = false;
  if (fingerprint(ringing) !== fingerprint(nextRinging)) {
    ringing = nextRinging;
    changed = true;
  }
  if (fingerprint(takeoverQueue) !== fingerprint(nextQueue)) {
    takeoverQueue = nextQueue;
    changed = true;
  }
  return changed;
}

function applyCoreList(next: Alarm[]): void {
  const listChanged = fingerprint(next) !== fingerprint(alarms);
  if (listChanged) alarms = next;
  pruneFiredThisRun();
  // An `alarm-fired` event for an alarm the poll already reported as fired
  // leaves the list identical but still moves the takeover queue, so the
  // derived lists get their own say in whether to notify.
  const derivedChanged = recomputeDerived();
  if (listChanged || derivedChanged) {
    for (const notify of listeners) notify();
  }
}

/** Monotonic token so an older in-flight read can't overwrite a newer one. */
let refreshSeq = 0;

export async function refreshAlarms(): Promise<void> {
  const seq = ++refreshSeq;
  try {
    const next = await listAlarms();
    // A poll issued before a dismissal can resolve after it. Applying that
    // older list would put the alarm back in the queue and re-raise the
    // takeover the user just dismissed.
    if (seq === refreshSeq) applyCoreList(next);
  } catch {
    // Leave the last known list in place; the periodic refresh will retry.
  }
}

function handleFired(alarm: Alarm): void {
  firedThisRun.add(alarm.id);
  // The core has already fullscreened and pinned the window by the time this
  // arrives, so raise the overlay straight off the payload. Waiting on the
  // refresh would strand the user in a pinned window with no alarm UI whenever
  // that one `list_alarms` call fails.
  applyCoreList(
    alarms.some((a) => a.id === alarm.id)
      ? alarms.map((a) => (a.id === alarm.id ? alarm : a))
      : [...alarms, alarm],
  );
  void refreshAlarms();
}

/** Bumped per registration so a late `listen` resolution can tell it's stale. */
let listenGeneration = 0;

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  if (listeners.size === 1) {
    const generation = ++listenGeneration;
    void refreshAlarms();
    pollTimer = setInterval(() => void refreshAlarms(), POLL_MS);
    onAlarmFired(handleFired).then((unlisten) => {
      // The last subscriber can leave while `listen` is still resolving — its
      // teardown had no unlisten to call yet, so drop the listener here rather
      // than leave it registered forever. StrictMode's double-subscribe on
      // mount hits this every time.
      if (generation === listenGeneration && listeners.size > 0) unlistenFired = unlisten;
      else unlisten();
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
  return useSyncExternalStore(subscribe, () => takeoverQueue);
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
