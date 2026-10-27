import { describe, expect, it } from "bun:test";
import {
  type CommitPullRequest,
  ciPassed,
  decideRevert,
  mergedPrFor,
  revertBody,
  revertQueries,
} from "./revert.ts";

const SHA = "a".repeat(40);
const pr: CommitPullRequest = {
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
    expect(decide()).toEqual({ action: "revert", pr });
  });

  it("re-runs the first failure, in case it was a flake", () => {
    expect(decide({ attempt: 1 })).toEqual({ action: "rerun" });
  });

  it("reverts a PR the bot merged on the merge reviewer's approval", () => {
    expect(decide({ path: "agent" })).toEqual({ action: "revert", pr });
  });

  it("leaves PRs that weren't auto-merged, including ones merged with /approve", () => {
    expect(decide({ path: "/approve" }).action).toBe("skip");
    expect(decide({ path: "human" }).action).toBe("skip");
  });

  it("leaves a failure that was already there on the parent commit", () => {
    expect(decide({ parentPassed: false })).toEqual({
      action: "skip",
      reason: "CI was already failing on the parent commit",
    });
  });

  it("leaves it alone, and says why, when the parent has no finished run to compare with", () => {
    expect(decide({ parentPassed: null })).toEqual({
      action: "skip",
      reason: "no finished CI run on the parent commit to compare with",
    });
  });

  it("doesn't revert on a re-run someone started by hand", () => {
    expect(decide({ attempt: 3 }).action).toBe("skip");
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

describe("ciPassed", () => {
  const ci = (conclusion: string | null, status = "completed") => ({
    name: "CI",
    conclusion,
    status,
  });

  it("passes when any finished run passed, such as a re-run of a flake", () => {
    expect(ciPassed([ci("failure"), ci("success")])).toBe(true);
    expect(ciPassed([ci("failure")])).toBe(false);
  });

  it("knows nothing from cancelled, skipped, running or other workflows' runs", () => {
    expect(
      ciPassed([
        ci("cancelled"),
        ci("skipped"),
        ci(null, "in_progress"),
        { name: "CodeQL", conclusion: "failure", status: "completed" },
      ]),
    ).toBeNull();
  });
});

describe("revertQueries", () => {
  it("only counts reverts the bot opened, or that merged, so an outsider's PR can't block one", () => {
    expect(revertQueries("bennettaur/yarvis", 7, "yarvis-bot")).toEqual([
      'repo:bennettaur/yarvis is:pr "Reverts bennettaur/yarvis#7" in:body author:app/yarvis-bot',
      'repo:bennettaur/yarvis is:pr "Reverts bennettaur/yarvis#7" in:body is:merged',
    ]);
  });
});
