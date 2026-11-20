/**
 * Live updates for the alarm list: the app re-reads it on `changed`, and the
 * scheduler re-checks when the next alarm is due. Process-local, like the
 * heads-down hub; the database holds the record.
 */
export type AlarmStreamEvent = { type: "changed" } | { type: "ping" };

type Listener = (event: AlarmStreamEvent) => void;

const listeners = new Set<Listener>();

/** Fans an event out to every listener. Never throws to the caller. */
export function publish(event: AlarmStreamEvent): void {
  for (const listener of listeners) {
    try {
      listener(event);
    } catch (e) {
      console.error("[alarms] stream listener failed:", e instanceof Error ? e.message : e);
    }
  }
}

export function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
