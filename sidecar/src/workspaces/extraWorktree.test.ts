import { describe, expect, it } from "bun:test";
import { branchCollision, isReservedBranchName } from "./extraWorktree.ts";

describe("branchCollision", () => {
  it("matches an existing branch whatever its case, and one it would nest with", () => {
    const existing = ["main", "stack", "team/feature"];
    expect(branchCollision("Main", existing)).toBe("main");
    expect(branchCollision("stack/two", existing)).toBe("stack");
    expect(branchCollision("TEAM", existing)).toBe("team/feature");
    expect(branchCollision("stacked", existing)).toBeNull();
  });

  it("refuses names git reads as something else", () => {
    for (const name of ["origin/main", "Refs/x", "HEAD", "head", "ORIG_HEAD", "tags/v1"]) {
      expect(isReservedBranchName(name)).toBe(true);
    }
    expect(isReservedBranchName("originals/x")).toBe(false);
  });
});
