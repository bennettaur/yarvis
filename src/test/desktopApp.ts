/**
 * Makes the page look like it runs inside the Tauri window, so `inTauri()`
 * and the machine-local features it gates are on. The `invoke` stub in
 * `setup.ts` answers whatever those features call. Returns the function that
 * puts the browser back, for the suite's `afterAll`.
 */
export function actAsDesktopApp(): () => void {
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown };
  w.__TAURI_INTERNALS__ = {};
  return () => {
    delete w.__TAURI_INTERNALS__;
  };
}
