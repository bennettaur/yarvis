import { mock } from "bun:test";

/**
 * Per-test answers for a workspace's review comments.
 *
 * `useReviewComments` is read by both the comments view and the side panel's
 * tab badge, so every suite rendering either one needs the same stub of
 * `lib/workspaceReview`. Two suites each registering their own would leave
 * the run with whichever loaded last. Registering once here, with an empty
 * list unless a test says otherwise, keeps it out of file order.
 */

type ReviewCommentsApi = typeof import("../lib/workspaceReview");
type Overrides = Partial<
  Pick<
    ReviewCommentsApi,
    "listReviewComments" | "createReviewComment" | "updateReviewComment" | "deleteReviewComment"
  >
>;

// Copied, not kept as the module namespace: that is live, so once the mock
// below is registered it would name the stubs, and a stub passing through
// would call itself.
const actual = { ...(await import("../lib/workspaceReview")) };
let overrides: Overrides = {};

export function stubReviewComments(next: Overrides): void {
  overrides = { ...overrides, ...next };
}

export function resetReviewComments(): void {
  overrides = {};
}

mock.module("../lib/workspaceReview", () => ({
  ...actual,
  listReviewComments: (...args: Parameters<ReviewCommentsApi["listReviewComments"]>) =>
    overrides.listReviewComments ? overrides.listReviewComments(...args) : Promise.resolve([]),
  createReviewComment: (...args: Parameters<ReviewCommentsApi["createReviewComment"]>) =>
    (overrides.createReviewComment ?? actual.createReviewComment)(...args),
  updateReviewComment: (...args: Parameters<ReviewCommentsApi["updateReviewComment"]>) =>
    (overrides.updateReviewComment ?? actual.updateReviewComment)(...args),
  deleteReviewComment: (...args: Parameters<ReviewCommentsApi["deleteReviewComment"]>) =>
    (overrides.deleteReviewComment ?? actual.deleteReviewComment)(...args),
}));
