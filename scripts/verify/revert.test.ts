import { describe, expect, it } from "bun:test";
import { decideRevert, type MergedPr, mergedPrFor, revertBody } from "./revert.ts";

const SHA = "a".repeat(40);
const pr: MergedPr = {
  number: 7,
  node_id: "PR_7",
  title: "Resize the list",
  merged_at: "2026-10-19T00:00:00Z",
  merge_commit_sha: SHA,
};

const decide = (overrides: Partial<Parameters<typeof decideRevert>[0]> = {}) =>
  decideRevert({
    pr,
    path: "auto",
    attempt: 2,
    parentPassed: true,
    alreadyReverted: false,
    ...overrides,
  });

describe("decideRevert", () => {
  it("reverts an auto-merged PR that still fails on a re-run", () => {
    expect(decide()).toEqual({ action: "revert" });
  });

  it("re-runs the first failure, in case it was a flake", () => {
    expect(decide({ attempt: 1 })).toEqual({ action: "rerun" });
  });

  it("leaves PRs a person approved, including with /approve", () => {
    expect(decide({ path: "/approve" }).action).toBe("skip");
    expect(decide({ path: "human" }).action).toBe("skip");
  });

  it("leaves a failure that was already there on the parent commit", () => {
    expect(decide({ parentPassed: false }).action).toBe("skip");
    expect(decide({ parentPassed: null }).action).toBe("skip");
  });

  it("doesn't open a second revert", () => {
    expect(decide({ alreadyReverted: true }).action).toBe("skip");
  });

  it("does nothing for a commit no PR made", () => {
    expect(decide({ pr: null }).action).toBe("skip");
  });
});

describe("mergedPrFor", () => {
  it("finds the PR whose merge made the commit, not one that only contains it", () => {
    const open = { ...pr, number: 8, merged_at: null, merge_commit_sha: SHA };
    const other = { ...pr, number: 9, merge_commit_sha: "b".repeat(40) };
    expect(mergedPrFor([open, other, pr], SHA)?.number).toBe(7);
    expect(mergedPrFor([open, other], SHA)).toBeNull();
  });
});

describe("revertBody", () => {
  it("starts with GitHub's revert line, which calibration counts", () => {
    const body = revertBody("bennettaur/yarvis", pr, SHA, "https://example.test/run");
    expect(body.split("\n")[0]).toBe("Reverts bennettaur/yarvis#7");
  });
});
