/**
 * Tracks how far along sidecar startup is, so `/health` can report whether the
 * service is usable yet. The frontend polls this to show a loading screen while
 * the sidecar boots and applies database migrations.
 */
export type ReadinessPhase = "migrating" | "ready" | "error";

export interface ReadinessState {
  phase: ReadinessPhase;
  /** Set when `phase` is "error". */
  error?: string;
}

export interface Readiness {
  get(): ReadinessState;
  set(phase: ReadinessPhase, error?: string): void;
}

export function createReadiness(initial: ReadinessPhase = "ready"): Readiness {
  let state: ReadinessState = { phase: initial };
  return {
    get: () => state,
    set: (phase, error) => {
      state = error ? { phase, error } : { phase };
    },
  };
}
