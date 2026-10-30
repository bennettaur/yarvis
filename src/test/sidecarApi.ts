import { mock } from "bun:test";

/**
 * Per-test answers for the sidecar client in `lib/api`.
 *
 * `mock.module` replaces a module for the whole run, so when each suite
 * registered its own partial stub of `lib/api`, a file that imported something
 * the live stub left out (`SidecarError`, say) failed to load, depending on
 * file order. Registering one stub here keeps every export, passes each call
 * through to the real client unless a test has set an override, and
 * `resetSidecarApi` clears them.
 */

type SidecarApi = typeof import("../lib/api");
type Overrides = Partial<Omit<SidecarApi, "SidecarError">>;

// Copied, not kept as the module namespace: that is live, so once the mock
// below is registered it would name the stubs, and a stub passing through
// would call itself.
const actual = { ...(await import("../lib/api")) };

/** The real client, for a stub that hands the calls it doesn't handle back. */
export const realSidecarApi: Readonly<SidecarApi> = actual;
let overrides: Overrides = {};

export function stubSidecarApi(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

export function resetSidecarApi(): void {
  overrides = {};
}

const through =
  <K extends keyof Overrides>(name: K) =>
  // biome-ignore lint/suspicious/noExplicitAny: forwards whatever the real function takes
  (...args: any[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: same
    ((overrides[name] ?? actual[name]) as any)(...args);

mock.module("../lib/api", () => ({
  ...actual,
  sidecarInfo: through("sidecarInfo"),
  sidecarFetch: through("sidecarFetch"),
  ensureOk: through("ensureOk"),
  getHealth: through("getHealth"),
  waitForSidecarReady: through("waitForSidecarReady"),
  getStatus: through("getStatus"),
  getDbHealth: through("getDbHealth"),
  streamSSE: through("streamSSE"),
}));
