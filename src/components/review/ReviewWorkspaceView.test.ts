import { describe, expect, it } from "bun:test";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { isSettling, tabPrefix } from "./ReviewWorkspaceView";

const pr = (repo: string, number: number, over: Partial<ReviewWorkspacePr> = {}) =>
  ({
    id: `${repo}-${number}`,
    ref: { provider: "github", owner: "acme", repo, number },
    status: "ready",
    worktreeStatus: "ready",
    setupStatus: null,
    ...over,
  }) as ReviewWorkspacePr;

describe("tabPrefix", () => {
  it("is just the number while every PR shares a repo", () => {
    const prs = [pr("widgets", 7), pr("widgets", 9)];
    expect(tabPrefix(prs[0]!, prs)).toBe("#7");
  });

  it("names the repo once PRs come from more than one", () => {
    const prs = [pr("widgets", 7), pr("gadgets", 9)];
    expect(tabPrefix(prs[1]!, prs)).toBe("gadgets#9");
  });
});

describe("isSettling", () => {
  it("is true while a clone, checkout, setup or archive is moving", () => {
    expect(isSettling({ status: "active", prs: [pr("w", 1)] })).toBe(false);
    expect(isSettling({ status: "active", prs: [pr("w", 1, { status: "cloning" })] })).toBe(true);
    expect(
      isSettling({ status: "active", prs: [pr("w", 1, { worktreeStatus: "checking-out" })] }),
    ).toBe(true);
    expect(isSettling({ status: "active", prs: [pr("w", 1, { setupStatus: "running" })] })).toBe(
      true,
    );
    expect(isSettling({ status: "archiving", prs: [] })).toBe(true);
  });
});
