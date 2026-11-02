/**
 * Tells open artifact panes that an artifact changed, so the user can watch the
 * agent write it. Process-local, like the activity hub: a change nobody is
 * watching is dropped, and a pane fetches the artifact itself on each signal.
 *
 * A second app instance sharing the database has its own hub, so a pane there
 * won't hear about writes made here until it reopens the artifact.
 */

export type ArtifactChange = "updated" | "deleted";

type Listener = (change: ArtifactChange) => void;

const listeners = new Map<string, Set<Listener>>();

/** Never throws to the caller: a failing stream must not fail the write that triggered it. */
export function publishArtifactChange(id: string, change: ArtifactChange): void {
  for (const listener of listeners.get(id) ?? []) {
    try {
      listener(change);
    } catch (e) {
      console.error("[artifacts] stream listener failed:", e instanceof Error ? e.message : e);
    }
  }
}

/** Returns an unsubscribe to call when the stream closes. */
export function subscribeArtifact(id: string, listener: Listener): () => void {
  let set = listeners.get(id);
  if (!set) {
    set = new Set();
    listeners.set(id, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0 && listeners.get(id) === set) listeners.delete(id);
  };
}
