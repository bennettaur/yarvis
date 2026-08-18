import { describe, expect, it } from "bun:test";
import { prGlance, prGlanceBadge } from "./workspacePrStatus";
import type { WorkspaceSummaryPr } from "./workspaces";

const PR: WorkspaceSummaryPr = {
  repoName: "web",
  prNumber: 12,
  prUrl: "https://github.com/acme/web/pull/12",
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

  it("reports an approved PR with settled checks as ready to merge", () => {
    expect(prGlance({ ...PR, reviewDecision: "approved" })).toBe("ready");
    expect(prGlance({ ...PR, reviewDecision: "approved", checkRollup: "none" })).toBe("ready");
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
    expect(badge.label).toBe("web #12 approved — ready to merge");
    expect(badge.icon).toBe("✓");
  });
});
