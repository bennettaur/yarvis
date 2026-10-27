import { mock } from "bun:test";

/**
 * Per-test answers for the review workspace's clients, for components that
 * call them directly rather than through a primed resource cache.
 *
 * Many suites replace `lib/api` for the whole run with partial stubs, so a
 * test that spies on `sidecarFetch` sees whichever stub loaded last, and its
 * answers depend on file order. Stubbing one level up avoids that: these
 * modules are registered once, pass every call through to the real client
 * unless a test has set an override, and `resetReviewApi` clears them.
 */

type ReviewApi = typeof import("../lib/reviewWorkspaces/api");
type VerificationApi = typeof import("../lib/reviewWorkspaces/verification");
type AgentRunsApi = typeof import("../lib/agentRuns");
type MutationApi = typeof import("../lib/reviewWorkspaces/mutation");
type MutationConfigApi = typeof import("../lib/pr/mutationTestingConfig");
type SinceReviewApi = typeof import("../lib/reviewWorkspaces/sinceReview");
type RereviewApi = typeof import("../lib/reviewWorkspaces/rereview");
type PrModelsApi = typeof import("../lib/pr/models");
type Overrides = Partial<
  ReviewApi &
    VerificationApi &
    AgentRunsApi &
    MutationApi &
    MutationConfigApi &
    SinceReviewApi &
    RereviewApi &
    PrModelsApi
>;

// Copied, not kept as the module namespaces: those are live, so once the mocks
// below are registered they would name the stubs, and a stub passing through
// would call itself.
const review = { ...(await import("../lib/reviewWorkspaces/api")) };
const verification = { ...(await import("../lib/reviewWorkspaces/verification")) };
const agentRuns = { ...(await import("../lib/agentRuns")) };
const mutation = { ...(await import("../lib/reviewWorkspaces/mutation")) };
const mutationConfig = { ...(await import("../lib/pr/mutationTestingConfig")) };
const sinceReview = { ...(await import("../lib/reviewWorkspaces/sinceReview")) };
const rereview = { ...(await import("../lib/reviewWorkspaces/rereview")) };
const prModels = { ...(await import("../lib/pr/models")) };
let overrides: Overrides = {};

export function stubReviewApi(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

export function resetReviewApi(): void {
  overrides = {};
}

const through =
  // biome-ignore lint/suspicious/noExplicitAny: forwards whatever the real function takes
    <M extends Record<string, any>, K extends keyof M & keyof Overrides>(actual: M, name: K) =>
    // biome-ignore lint/suspicious/noExplicitAny: same
    (...args: any[]) =>
      // biome-ignore lint/suspicious/noExplicitAny: same
      ((overrides[name] ?? actual[name]) as any)(...args);

mock.module("../lib/reviewWorkspaces/api", () => ({
  ...review,
  reviewSetupInfo: through(review, "reviewSetupInfo"),
  answerReviewSetup: through(review, "answerReviewSetup"),
  removeReviewPr: through(review, "removeReviewPr"),
  refreshReviewPr: through(review, "refreshReviewPr"),
  followReviewPrProgress: through(review, "followReviewPrProgress"),
  archiveReviewWorkspace: through(review, "archiveReviewWorkspace"),
  reviewChangedFiles: through(review, "reviewChangedFiles"),
  reviewTree: through(review, "reviewTree"),
}));

mock.module("../lib/reviewWorkspaces/verification", () => ({
  ...verification,
  startVerification: through(verification, "startVerification"),
  latestVerification: through(verification, "latestVerification"),
}));

mock.module("../lib/agentRuns", () => ({
  ...agentRuns,
  streamAgentRun: through(agentRuns, "streamAgentRun"),
  cancelAgentRun: through(agentRuns, "cancelAgentRun"),
}));

mock.module("../lib/reviewWorkspaces/mutation", () => ({
  ...mutation,
  getMutationTesting: through(mutation, "getMutationTesting"),
  startMutationTesting: through(mutation, "startMutationTesting"),
  cancelMutationTesting: through(mutation, "cancelMutationTesting"),
  followMutationProgress: through(mutation, "followMutationProgress"),
}));

mock.module("../lib/reviewWorkspaces/sinceReview", () => ({
  ...sinceReview,
  markReviewedHere: through(sinceReview, "markReviewedHere"),
}));

mock.module("../lib/reviewWorkspaces/rereview", () => ({
  ...rereview,
  latestRereview: through(rereview, "latestRereview"),
  startRereview: through(rereview, "startRereview"),
}));

mock.module("../lib/pr/models", () => ({
  ...prModels,
  getRereviewRunConfig: through(prModels, "getRereviewRunConfig"),
}));

mock.module("../lib/pr/mutationTestingConfig", () => ({
  ...mutationConfig,
  getMutationTestingConfig: through(mutationConfig, "getMutationTestingConfig"),
}));
