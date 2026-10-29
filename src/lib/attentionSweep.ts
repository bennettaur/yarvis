import { useSyncExternalStore } from "react";
import { saveAttentionSweep } from "./settings";

/**
 * Whether an amber band sweeps across the top bar while the attention bell has
 * something pending (`components/shell/TopBar.tsx`). On unless turned off in
 * Settings → Appearance; kept in `settings.json`, so it survives a restart and
 * is shared by every instance of the app. The bell rings either way.
 */

let current = true;
const listeners = new Set<() => void>();
// Saves run one after another, so the file ends on the last choice even when
// the toggle is flipped faster than a save completes.
let saving: Promise<unknown> = Promise.resolve();

export function getAttentionSweep(): boolean {
  return current;
}

/** Takes the stored choice at launch. Only an explicit `false` turns it off. */
export function loadAttentionSweep(raw: unknown): void {
  current = raw !== false;
}

/**
 * Applies the choice straight away and saves it. Rejects only when the save
 * failed, in which case the choice still holds until the app restarts.
 */
export function setAttentionSweep(enabled: boolean): Promise<void> {
  if (enabled === current) return Promise.resolve();
  current = enabled;
  for (const listener of listeners) listener();
  const save = saving.then(() => saveAttentionSweep(enabled ? null : false));
  saving = save.catch(() => {});
  return save.then(() => {});
}

function onAttentionSweep(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAttentionSweep(): boolean {
  return useSyncExternalStore(onAttentionSweep, getAttentionSweep);
}
