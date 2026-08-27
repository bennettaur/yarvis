import { describe, expect, it } from "bun:test";
import type { PrStack, StackEntry } from "../pr/types.ts";
import type { RunResult } from "./exec.ts";
import { applyGhStack, type GhRunner, loadWorkspaceStack, mergeStack } from "./stack.ts";

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0 });

/** Records what `gh` was asked to do and replies with a canned result. */
function fakeGh(reply: RunResult | ((args: string[]) => RunResult)): {
  gh: GhRunner;
  calls: string[][];
} {
  const calls: string[][] = [];
  return {
    calls,
    gh: async (args) => {
      calls.push(args);
      return typeof reply === "function" ? reply(args) : reply;
    },
  };
}

const entry = (number: number, headRef: string, extra: Partial<StackEntry> = {}): StackEntry => ({
  ref: { provider: "github", owner: "o", repo: "r", number },
  number,
  title: `pr ${number}`,
  url: `https://github.com/o/r/pull/${number}`,
  baseRef: "",
  headRef,
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 1, success: 1, failure: 0, pending: 0 },
  reviewDecision: "approved",
  isCurrent: false,
  needsUpdate: false,
  ...extra,
});

const derived: PrStack = {
  trunk: "main",
  stackNumber: null,
  source: "refs",
  entries: [entry(1, "auth"), entry(2, "api", { isCurrent: true })],
};

const view = {
  trunk: "main",
  currentBranch: "api",
  number: 7,
  branches: [
    { name: "auth", isMerged: false, needsRebase: false, pr: { number: 1, state: "OPEN" } },
    { name: "api", isCurrent: true, needsRebase: true, pr: { number: 2, state: "OPEN" } },
  ],
};

describe("applyGhStack", () => {
  it("keeps the API's per-layer status while taking the CLI's grouping", () => {
    const stack = applyGhStack(derived, view, "o", "r");

    expect(stack.source).toBe("gh-stack");
    expect(stack.stackNumber).toBe(7);
    expect(stack.entries.map((e) => e.number)).toEqual([1, 2]);
    expect(stack.entries[1]?.reviewDecision).toBe("approved");
    expect(stack.entries[1]?.checks.success).toBe(1);
  });

  it("takes either source's word that a layer needs restacking", () => {
    const stack = applyGhStack(derived, view, "o", "r");
    // Only the CLI said so here, and that is enough.
    expect(stack.entries.map((e) => e.needsUpdate)).toEqual([false, true]);
  });

  // The branch walk cannot tell a stack from two unrelated PRs that happen to
  // chain; `gh stack` can, so its list decides who is in.
  it("drops a pull request the CLI does not consider part of the stack", () => {
    const withStranger: PrStack = {
      ...derived,
      entries: [...derived.entries, entry(3, "unrelated")],
    };
    expect(applyGhStack(withStranger, view, "o", "r").entries.map((e) => e.number)).toEqual([1, 2]);
  });

  it("includes a branch that has no pull request yet", () => {
    const withDraftBranch = {
      ...view,
      branches: [...view.branches, { name: "ui", isCurrent: false }],
    };
    const stack = applyGhStack(derived, withDraftBranch, "o", "r");

    expect(stack.entries).toHaveLength(3);
    expect(stack.entries[2]).toMatchObject({ number: 0, headRef: "ui", state: "none" });
  });

  it("builds the whole stack from the CLI when GitHub gave nothing", () => {
    const stack = applyGhStack(null, view, "o", "r");
    expect(stack.entries.map((e) => e.headRef)).toEqual(["auth", "api"]);
    expect(stack.entries[1]?.isCurrent).toBe(true);
  });
});

describe("loadWorkspaceStack", () => {
  it("reads the stack out of the worktree", async () => {
    const { gh, calls } = fakeGh(ok(JSON.stringify(view)));
    const result = await loadWorkspaceStack({
      gh,
      client: null,
      worktreePath: "/w/api",
      owner: "o",
      repo: "r",
      prNumber: null,
    });

    expect(calls[0]).toEqual(["stack", "view", "--json"]);
    expect(result.ghStackError).toBeNull();
    expect(result.stack?.entries.map((e) => e.headRef)).toEqual(["auth", "api"]);
  });

  // No stack, no extension and no `gh` at all are all ordinary answers here,
  // and the reason is what tells the user which one they hit.
  it("reports why gh stack could not answer rather than failing", async () => {
    const { gh } = fakeGh({ stdout: "", stderr: "unknown command: stack", exitCode: 1 });
    const result = await loadWorkspaceStack({
      gh,
      client: null,
      worktreePath: "/w/api",
      owner: "o",
      repo: "r",
      prNumber: null,
    });

    expect(result.stack).toBeNull();
    expect(result.ghStackError).toBe("unknown command: stack");
  });

  it("reports unparseable output rather than throwing at the route", async () => {
    const { gh } = fakeGh(ok("not json"));
    const result = await loadWorkspaceStack({
      gh,
      client: null,
      worktreePath: "/w/api",
      owner: "o",
      repo: "r",
      prNumber: null,
    });
    expect(result.ghStackError).toBe("could not parse gh stack view output");
  });
});

describe("mergeStack", () => {
  it("merges up to a pull request without prompting", async () => {
    const { gh, calls } = fakeGh(ok("merged 2 pull requests"));
    const result = await mergeStack(gh, "/w/api", 2, "SQUASH");

    expect(calls[0]).toEqual(["stack", "merge", "2", "--yes", "--squash"]);
    expect(result).toEqual({ merged: true, output: "merged 2 pull requests" });
  });

  it("leaves the method to gh when the caller names none", async () => {
    const { gh, calls } = fakeGh(ok(""));
    await mergeStack(gh, "/w/api", 5);
    expect(calls[0]).toEqual(["stack", "merge", "5", "--yes"]);
  });

  // The stack is all-or-nothing on GitHub's side, so the refusal reason is the
  // whole of what the user gets to act on.
  it("returns gh's refusal rather than throwing it away", async () => {
    const { gh } = fakeGh({ stdout: "", stderr: "#3 is a draft", exitCode: 1 });
    expect(await mergeStack(gh, "/w/api", 3)).toEqual({ merged: false, output: "#3 is a draft" });
  });
});
