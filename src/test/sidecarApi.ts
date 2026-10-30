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
 *
 * An override changes what code outside `lib/api` sees. Inside it, the real
 * `getHealth` and `streamSSE` still call the real `sidecarInfo` and
 * `sidecarFetch`, so a suite that needs them answered stubs them directly.
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

/** Adds to the overrides already set; they last until `resetSidecarApi`. */
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

// Every function is wrapped, so one added to `lib/api` can be stubbed without
// touching this file. `SidecarError` stays the real class for `instanceof`.
const overridable = (Object.keys(actual) as (keyof SidecarApi)[]).filter(
  (name): name is keyof Overrides => name !== "SidecarError" && typeof actual[name] === "function",
);

mock.module("../lib/api", () => ({
  ...actual,
  ...Object.fromEntries(overridable.map((name) => [name, through(name)])),
}));
