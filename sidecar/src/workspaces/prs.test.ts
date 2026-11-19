import { describe, expect, it } from "bun:test";
import { branchPr, isOnBranch, mainPr, orderPrs } from "./prs.ts";

/** A linked PR on `headBranch` in `prState`. */
const pr = (
  prNumber: number,
  prState: string | null,
  headBranch: string | null = "topic",
  dismissed = false,
) => ({ prNumber, prState, headBranch, dismissed });

describe("orderPrs", () => {
  it("puts open before merged before closed, newest first within each", () => {
    const ordered = orderPrs(
      [pr(1, "closed"), pr(2, "merged"), pr(3, "open"), pr(4, "merged"), pr(5, "open")],
      "topic",
    );
    expect(ordered.map((p) => p.prNumber)).toEqual([5, 3, 4, 2, 1]);
  });

  it("puts the worktree's own branch ahead of an open PR from another branch", () => {
    const ordered = orderPrs([pr(9, "open", "stack-2"), pr(4, "merged", "topic")], "topic");
    expect(ordered.map((p) => p.prNumber)).toEqual([4, 9]);
  });

  it("leaves out the PRs the user unlinked", () => {
    const ordered = orderPrs([pr(1, "open", "topic", true), pr(2, "open")], "topic");
    expect(ordered.map((p) => p.prNumber)).toEqual([2]);
  });
});

describe("mainPr", () => {
  it("is null when every PR was unlinked, or there are none", () => {
    expect(mainPr([], "topic")).toBeNull();
    expect(mainPr([pr(1, "open", "topic", true)], "topic")).toBeNull();
  });

  it("falls back to another branch's PR when the worktree's own has none", () => {
    expect(mainPr([pr(9, "open", "stack-2")], "topic")?.prNumber).toBe(9);
  });
});

describe("branchPr", () => {
  it("never picks a PR from another branch", () => {
    expect(branchPr([pr(9, "open", "stack-2")], "topic")).toBeNull();
    expect(branchPr([pr(9, "open", "stack-2"), pr(4, "merged")], "topic")?.prNumber).toBe(4);
  });
});

describe("isOnBranch", () => {
  it("trusts only a PR known to merge from the repo's own branch", () => {
    expect(isOnBranch(pr(1, "open", "topic"), "topic")).toBe(true);
    expect(isOnBranch(pr(1, "open", null), "topic")).toBe(false);
    expect(isOnBranch(pr(1, "open", "other"), "topic")).toBe(false);
    // A fork's same-named branch, as the providers' reads store it.
    expect(isOnBranch(pr(1, "open", "someone:topic"), "topic")).toBe(false);
  });
});
