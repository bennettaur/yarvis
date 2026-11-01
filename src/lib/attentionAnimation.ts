import { useSyncExternalStore } from "react";
import { saveAttentionAnimation } from "./settings";

/**
 * Whether the top bar animates while the attention bell has something pending
 * (`components/shell/TopBar.tsx`): an amber band sweeps across it and the bell
 * shakes. On unless turned off in Settings → Appearance; kept in
 * `settings.json`, so it survives a restart and is shared by every instance of
 * the app. The count badge shows either way.
 */

let current = true;
const listeners = new Set<() => void>();
// Saves run one after another, so the file ends on the last choice even when
// the toggle is flipped faster than a save completes.
let saving: Promise<unknown> = Promise.resolve();

export function getAttentionAnimation(): boolean {
  return current;
}

/** Takes the stored choice at launch. Only an explicit `false` turns it off. */
export function loadAttentionAnimation(raw: unknown): void {
  current = raw !== false;
}

/**
 * Applies the choice straight away and saves it. Rejects only when the save
 * failed, in which case the choice still holds until the app restarts.
 */
export function setAttentionAnimation(enabled: boolean): Promise<void> {
  if (enabled === current) return Promise.resolve();
  current = enabled;
  for (const listener of listeners) listener();
  const save = saving.then(() => saveAttentionAnimation(enabled ? null : false));
  saving = save.catch(() => {});
  return save.then(() => {});
}

function onAttentionAnimation(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useAttentionAnimation(): boolean {
  return useSyncExternalStore(onAttentionAnimation, getAttentionAnimation);
}
