import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import type { PrStack, StackEntry } from "../../lib/pr/types";
import type { StackMergeResult, WorkspaceRepoDetail, WorkspaceStack } from "../../lib/workspaces";
import { mountForInteraction, textOf } from "../../test/render";

let stackResult: WorkspaceStack | Error;
let mergeCalls: { upTo: number; expect: number[]; method?: string }[] = [];
let mergeResult: StackMergeResult | Error = { merged: true, output: "merged" };

// Only the two stack calls are stubbed; the rest of the module stays real so
// sibling tests still see the actual implementations.
const actual = await import("../../lib/workspaces");
mock.module("../../lib/workspaces", () => ({
  ...actual,
  workspaceRepoStack: async () => {
    if (stackResult instanceof Error) throw stackResult;
    return stackResult;
  },
  mergeWorkspaceRepoStack: async (
    _workspaceId: string,
    _repoId: string,
    upTo: number,
    expected: number[],
    method?: string,
  ) => {
    mergeCalls.push({ upTo, expect: expected, method });
    if (mergeResult instanceof Error) throw mergeResult;
    return mergeResult;
  },
}));

const { default: WorkspaceStackView } = await import("./WorkspaceStackView");

const entry = (number: number, headRef: string, extra: Partial<StackEntry> = {}): StackEntry => ({
  ref: { provider: "github", owner: "octo", repo: "web", number },
  number,
  title: `layer ${number}`,
  url: `https://github.com/octo/web/pull/${number}`,
  baseRef: "",
  headRef,
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 1, success: 1, failure: 0, pending: 0 },
  reviewDecision: null,
  isCurrent: false,
  needsUpdate: false,
  statusKnown: true,
  ...extra,
});

const stack = (entries: StackEntry[]): PrStack => ({
  trunk: "main",
  entries,
  stackNumber: 7,
  truncated: false,
});

const TWO_LAYERS = stack([entry(1, "auth"), entry(2, "api", { isCurrent: true })]);

const REPO = {
  id: "wr-1",
  branch: "api",
  repo: { name: "web" },
} as unknown as WorkspaceRepoDetail;

const view = () => mountForInteraction(<WorkspaceStackView workspaceId="ws-1" repo={REPO} />);

/** Clicks the button whose text starts with `label`. */
function click(host: HTMLElement, label: string): void {
  const button = [...host.querySelectorAll("button")].find((b) =>
    (b.textContent ?? "").startsWith(label),
  );
  if (!button) throw new Error(`no button starting with "${label}" in: ${host.textContent}`);
  button.click();
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 100));

let unmount: (() => void) | null = null;

beforeEach(() => {
  mergeCalls = [];
  mergeResult = { merged: true, output: "merged" };
  stackResult = { stack: TWO_LAYERS, ghStackError: null, prStackError: null };
});

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("WorkspaceStackView", () => {
  it("lists the stack and its number", async () => {
    const mounted = await view();
    unmount = mounted.unmount;
    const text = textOf(mounted.host.innerHTML);

    expect(text).toContain("2 PRs");
    expect(text).toContain("stack #7");
    expect(text).toContain("layer 1");
  });

  // One boolean stands between a click and merging several pull requests, so
  // the first press must be inert.
  it("does not merge on the first press", async () => {
    const mounted = await view();
    unmount = mounted.unmount;

    click(mounted.host, "Merge stack up to #2");
    await settle();

    expect(mergeCalls).toEqual([]);
    expect(textOf(mounted.host.innerHTML)).toContain("Merge 2 PRs — confirm");
  });

  it("merges on the second press, sending the plan it promised", async () => {
    const mounted = await view();
    unmount = mounted.unmount;

    click(mounted.host, "Merge stack up to #2");
    await settle();
    click(mounted.host, "Merge 2 PRs");
    await settle();

    expect(mergeCalls).toEqual([{ upTo: 2, expect: [1, 2], method: undefined }]);
    expect(textOf(mounted.host.innerHTML)).toContain("merged");
  });

  it("cancels back to the unconfirmed button without merging", async () => {
    const mounted = await view();
    unmount = mounted.unmount;

    click(mounted.host, "Merge stack up to #2");
    await settle();
    click(mounted.host, "Cancel");
    await settle();

    expect(mergeCalls).toEqual([]);
    expect(textOf(mounted.host.innerHTML)).toContain("Merge stack up to #2");
  });

  // A stack whose bottom has landed merges fewer layers than it holds, and the
  // count is the only thing the user reads before an irreversible action.
  it("counts only the layers that would actually merge", async () => {
    stackResult = {
      stack: stack([entry(1, "auth", { merged: true }), entry(2, "api", { isCurrent: true })]),
      ghStackError: null,
      prStackError: null,
    };
    const mounted = await view();
    unmount = mounted.unmount;

    click(mounted.host, "Merge stack up to #2");
    await settle();

    expect(textOf(mounted.host.innerHTML)).toContain("Merge 1 PR — confirm");
  });

  it("shows the sidecar's refusal when the stack moved underneath the confirmation", async () => {
    mergeResult = new Error("the stack changed since you looked — it would now merge #1, #2, #3");
    const mounted = await view();
    unmount = mounted.unmount;

    click(mounted.host, "Merge stack up to #2");
    await settle();
    click(mounted.host, "Merge 2 PRs");
    await settle();

    expect(textOf(mounted.host.innerHTML)).toContain("the stack changed since you looked");
  });

  // The likely first-run state: the extension isn't installed yet.
  it("explains why there is no merge button when gh stack is unavailable", async () => {
    stackResult = {
      stack: TWO_LAYERS,
      ghStackError: "unknown command: stack",
      prStackError: null,
    };
    const mounted = await view();
    unmount = mounted.unmount;
    const text = textOf(mounted.host.innerHTML);

    expect(text).toContain("unknown command: stack");
    expect(text).not.toContain("Merge stack up to");
  });

  it("says why a layer's checks are blank when GitHub couldn't be reached", async () => {
    stackResult = { stack: TWO_LAYERS, ghStackError: null, prStackError: "github -> 502" };
    const mounted = await view();
    unmount = mounted.unmount;

    expect(textOf(mounted.host.innerHTML)).toContain("github -> 502");
  });

  it("reports a branch that is in no stack", async () => {
    stackResult = { stack: null, ghStackError: "not a stack", prStackError: null };
    const mounted = await view();
    unmount = mounted.unmount;
    const text = textOf(mounted.host.innerHTML);

    expect(text).toContain("No stack for");
    expect(text).toContain("not a stack");
  });

  it("surfaces a failed read", async () => {
    stackResult = new Error("load stack failed: 500");
    const mounted = await view();
    unmount = mounted.unmount;

    expect(textOf(mounted.host.innerHTML)).toContain("load stack failed: 500");
  });
});
