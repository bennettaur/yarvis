import { useSyncExternalStore } from "react";

/**
 * Microphone loudness, 0..1, held outside React state. It changes about ten
 * times a second while the mic is open, and continuous mode keeps the mic open
 * for the whole conversation; as state on `useVoice` every change would
 * re-render the chat surface. Only the component that draws it subscribes.
 */
export interface LevelMeter {
  get: () => number;
  set: (level: number) => void;
  subscribe: (onChange: () => void) => () => void;
}

export function createLevelMeter(initial = 0): LevelMeter {
  let level = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => level,
    set: (next) => {
      if (next === level) return;
      level = next;
      for (const listener of listeners) listener();
    },
    subscribe: (onChange) => {
      listeners.add(onChange);
      return () => listeners.delete(onChange);
    },
  };
}

export function useLevel(meter: LevelMeter): number {
  return useSyncExternalStore(meter.subscribe, meter.get);
}
