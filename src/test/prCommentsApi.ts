import { mock } from "bun:test";

/**
 * Per-test answers for posting a PR comment.
 *
 * Several suites post through `postPrComment`, and `mock.module` is global to
 * the run, so two suites each registering their own stub would leave every
 * suite with whichever loaded last. Registering once here, passing through to
 * the real client unless a test has set an override, keeps them out of file
 * order.
 */

type PrApi = typeof import("../lib/pr/api");
type Overrides = Partial<Pick<PrApi, "postPrComment">>;

// Copied, not kept as the module namespace: that is live, so once the mock
// below is registered it would name the stub, and a stub passing through
// would call itself.
const actual = { ...(await import("../lib/pr/api")) };
let overrides: Overrides = {};

export function stubPrComments(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

export function resetPrComments(): void {
  overrides = {};
}

mock.module("../lib/pr/api", () => ({
  ...actual,
  postPrComment: (...args: Parameters<PrApi["postPrComment"]>) =>
    (overrides.postPrComment ?? actual.postPrComment)(...args),
}));
