import { mock } from "bun:test";

/**
 * Per-test answers for the PR client in `lib/pr/api`.
 *
 * `mock.module` replaces a module for the whole run, so a suite registering its
 * own partial stub of `lib/pr/api` left every later file with that stub: a PR
 * component rendered after it read a detail with no body, and its thread
 * actions had no function to call. Registering one stub here keeps every
 * export, passes each call through to the real client unless a test has set an
 * override, and `resetPrApi` clears them.
 *
 * An override changes what code outside `lib/pr/api` sees. A real function
 * there calling another one in the same module still calls the real one.
 */

type PrApi = typeof import("../lib/pr/api");
type Overrides = Partial<PrApi>;

// Copied, not kept as the module namespace: that is live, so once the mock
// below is registered it would name the stubs, and a stub passing through
// would call itself.
const actual = { ...(await import("../lib/pr/api")) };
let overrides: Overrides = {};

/** Adds to the overrides already set; they last until `resetPrApi`. */
export function stubPrApi(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

export function resetPrApi(): void {
  overrides = {};
}

const through =
  <K extends keyof PrApi>(name: K) =>
  // biome-ignore lint/suspicious/noExplicitAny: forwards whatever the real function takes
  (...args: any[]) =>
    // biome-ignore lint/suspicious/noExplicitAny: same
    ((overrides[name] ?? actual[name]) as any)(...args);

// Every function is wrapped, so one added to `lib/pr/api` can be stubbed
// without touching this file. A class export would need leaving out, as
// `sidecarApi.ts` does for `SidecarError`, or `instanceof` stops working.
const overridable = (Object.keys(actual) as (keyof PrApi)[]).filter(
  (name) => typeof actual[name] === "function",
);

mock.module("../lib/pr/api", () => ({
  ...actual,
  ...Object.fromEntries(overridable.map((name) => [name, through(name)])),
}));
