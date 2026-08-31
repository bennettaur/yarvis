import { describe, expect, it } from "bun:test";
import type { StackEntry } from "./pr/types";
import { prGlance, prGlanceBadge, stackEntryBadge, stackEntryGlance } from "./prGlance";
import type { WorkspaceSummaryPr } from "./workspaces";

const PR: WorkspaceSummaryPr = {
  repoName: "web",
  prNumber: 12,
  prState: "open",
  isDraft: false,
  mergeable: "clean",
  checkRollup: "success",
  reviewDecision: "review_required",
};

describe("prGlance", () => {
  it("reports an open PR nobody has reviewed as awaiting review", () => {
    expect(prGlance(PR)).toBe("open");
  });

  it("reports an approved PR with settled checks as approved", () => {
    expect(prGlance({ ...PR, reviewDecision: "approved" })).toBe("approved");
    expect(prGlance({ ...PR, reviewDecision: "approved", checkRollup: "none" })).toBe("approved");
  });

  // Every Azure PR and every row written before the verdict was cached carries
  // a null decision; it must read as open, not as approved.
  it("reports an unknown verdict as awaiting review", () => {
    expect(prGlance({ ...PR, reviewDecision: null })).toBe("open");
    expect(prGlance({ ...PR, reviewDecision: null, prState: null })).toBe("open");
  });

  // Approved but red or still running is not ready — the CI state is what the
  // user has to act on, so it outranks the approval.
  it("keeps the check state ahead of an approval that isn't actionable yet", () => {
    expect(prGlance({ ...PR, reviewDecision: "approved", checkRollup: "failure" })).toBe(
      "checks_failing",
    );
    expect(prGlance({ ...PR, reviewDecision: "approved", checkRollup: "pending" })).toBe(
      "checks_running",
    );
  });

  it("puts failing checks ahead of a changes-requested review", () => {
    const pr = { ...PR, reviewDecision: "changes_requested", checkRollup: "failure" } as const;
    expect(prGlance(pr)).toBe("checks_failing");
    expect(prGlance({ ...pr, checkRollup: "success" })).toBe("changes_requested");
  });

  it("flags merge conflicts from either provider's vocabulary", () => {
    expect(prGlance({ ...PR, mergeable: "dirty" })).toBe("conflicts");
    expect(prGlance({ ...PR, mergeable: "CONFLICTING" })).toBe("conflicts");
  });

  // A draft is the author saying "not yet", so its checks and reviews aren't
  // asking anyone for anything.
  it("reports a draft as draft whatever its checks say", () => {
    expect(prGlance({ ...PR, isDraft: true, checkRollup: "failure" })).toBe("draft");
  });

  it("reports finished PRs by their state", () => {
    expect(prGlance({ ...PR, prState: "merged", isDraft: true })).toBe("merged");
    expect(prGlance({ ...PR, prState: "closed", checkRollup: "failure" })).toBe("closed");
  });
});

describe("prGlanceBadge", () => {
  it("names the repo and PR number in the tooltip", () => {
    const badge = prGlanceBadge({ ...PR, reviewDecision: "approved" });
    expect(badge.label).toBe("web #12 approved");
    expect(badge.icon).toBe("✓");
  });
});

const LAYER: StackEntry = {
  ref: { provider: "github", owner: "o", repo: "r", number: 4 },
  number: 4,
  title: "api routes",
  url: "https://github.com/o/r/pull/4",
  baseRef: "auth",
  headRef: "api",
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 2, success: 2, failure: 0, pending: 0 },
  reviewDecision: "review_required",
  isCurrent: false,
  needsUpdate: false,
  statusKnown: true,
};

describe("stackEntryGlance", () => {
  // Each of these puts two conditions in conflict, so it pins the precedence
  // rather than just the mapping.
  it("orders a layer's state by what the reader would act on first", () => {
    const failing = { total: 2, success: 0, failure: 1, pending: 1 };
    expect(
      stackEntryGlance({ ...LAYER, checks: failing, reviewDecision: "changes_requested" }),
    ).toBe("checks_failing");
    expect(
      stackEntryGlance({
        ...LAYER,
        checks: { total: 1, success: 0, failure: 0, pending: 1 },
        reviewDecision: "changes_requested",
      }),
    ).toBe("changes_requested");
    expect(
      stackEntryGlance({
        ...LAYER,
        checks: { total: 1, success: 0, failure: 0, pending: 1 },
        reviewDecision: "approved",
      }),
    ).toBe("checks_running");
  });

  it("maps each condition on its own", () => {
    expect(stackEntryGlance({ ...LAYER, checks: { ...LAYER.checks, failure: 1 } })).toBe(
      "checks_failing",
    );
    expect(stackEntryGlance({ ...LAYER, reviewDecision: "changes_requested" })).toBe(
      "changes_requested",
    );
    expect(stackEntryGlance({ ...LAYER, checks: { ...LAYER.checks, pending: 1 } })).toBe(
      "checks_running",
    );
    expect(stackEntryGlance({ ...LAYER, reviewDecision: "approved" })).toBe("approved");
    expect(stackEntryGlance(LAYER)).toBe("open");
  });

  // A landed or queued layer is settled: what its checks said no longer asks
  // anything of anyone.
  it("reports a settled layer by its lifecycle, not its checks", () => {
    const failing = { ...LAYER, checks: { total: 1, success: 0, failure: 1, pending: 0 } };
    expect(stackEntryGlance({ ...failing, merged: true })).toBe("merged");
    expect(stackEntryGlance({ ...failing, queued: true })).toBe("queued");
    expect(stackEntryGlance({ ...failing, draft: true })).toBe("draft");
  });

  // `gh stack` tracks a branch from creation, well before it has a PR.
  it("reports a branch with no pull request as such", () => {
    expect(stackEntryGlance({ ...LAYER, number: 0, state: "none" })).toBe("no_pr");
  });

  // A layer read while GitHub was unreachable has no checks and no reviews,
  // which is not the same as having clean ones.
  it("does not pass off an unread layer as open and awaiting review", () => {
    const unread = {
      ...LAYER,
      checks: { total: 0, success: 0, failure: 0, pending: 0 },
      reviewDecision: null,
      statusKnown: false,
    };
    expect(stackEntryGlance(unread)).toBe("unknown");
    expect(stackEntryGlance({ ...unread, statusKnown: true })).toBe("open");
    // What is known regardless still wins: the CLI reports merges by itself.
    expect(stackEntryGlance({ ...unread, merged: true })).toBe("merged");
  });
});

describe("stackEntryBadge", () => {
  it("names the PR in the tooltip and the state on its own for the row", () => {
    const badge = stackEntryBadge({ ...LAYER, merged: true });
    expect(badge.label).toBe("#4 merged");
    expect(badge.status).toBe("merged");
  });

  it("falls back to the branch name when there is no PR to name", () => {
    expect(stackEntryBadge({ ...LAYER, number: 0 }).label).toBe("api no pull request yet");
  });
});
