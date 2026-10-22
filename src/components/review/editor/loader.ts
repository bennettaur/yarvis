import type * as Monaco from "monaco-editor";
import { useEffect, useState } from "react";

export type MonacoApi = typeof Monaco;

let loading: Promise<MonacoApi> | null = null;
let loaded: MonacoApi | null = null;

/**
 * Monaco, fetched on first use. It is several megabytes with its workers, so
 * it lives in its own chunks and only a screen that shows an editor pays for
 * it. A failed load is not remembered, so the next editor tries again.
 */
export function loadMonaco(): Promise<MonacoApi> {
  if (!loading) {
    loading = import("./runtime").then(
      (runtime) => {
        loaded = runtime.monaco;
        return runtime.monaco;
      },
      (error) => {
        loading = null;
        throw error;
      },
    );
  }
  return loading;
}

/** Monaco if it has already loaded; registrations made before then wait for it. */
export function loadedMonaco(): MonacoApi | null {
  return loaded;
}

export type MonacoState =
  | { status: "loading" }
  | { status: "ready"; monaco: MonacoApi }
  | { status: "error"; error: unknown };

/** Monaco for a component, starting the load on mount. */
export function useMonaco(): MonacoState {
  const [state, setState] = useState<MonacoState>(() =>
    loaded ? { status: "ready", monaco: loaded } : { status: "loading" },
  );
  useEffect(() => {
    if (state.status !== "loading") return;
    let live = true;
    loadMonaco().then(
      (monaco) => live && setState({ status: "ready", monaco }),
      (error) => live && setState({ status: "error", error }),
    );
    return () => {
      live = false;
    };
  }, [state.status]);
  return state;
}
