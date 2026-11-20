import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { act, createElement, useState } from "react";
import { DEFAULT_MUTATION_TESTING_CONFIG } from "../../../lib/pr/mutationTestingConfig";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../../lib/reviewWorkspaces/cache";
import type {
  MutationProgressEvent,
  MutationRun,
  MutationTestingState,
} from "../../../lib/reviewWorkspaces/mutation";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import MutationTab from "./MutationTab";
import { mutationKey } from "./reviewData";
import type { TabContext } from "./types";

const HEAD = "a".repeat(40);
const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  status: "ready",
  worktreeStatus: "ready",
  headSha: HEAD,
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;

let setupOpened = 0;
const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: pr.ref,
  diffMode: "split",
  openTab: () => {},
  openSetup: () => {
    setupOpened++;
  },
};

let started: unknown[] = [];
let cancels = 0;
/** Events the next followed stream yields. */
let streamed: MutationProgressEvent[] = [];
/** What the stream does after them: wait for its abort, just end, or fail. */
let streamThen: "wait" | "end" | "throw" = "wait";
let streamAborted = false;
/** What re-reading the PR's mutation state answers. */
let current: MutationTestingState;

beforeEach(() => {
  started = [];
  cancels = 0;
  setupOpened = 0;
  streamed = [];
  streamThen = "wait";
  streamAborted = false;
  stubReviewApi({
    getMutationTestingConfig: async () => DEFAULT_MUTATION_TESTING_CONFIG,
    getMutationTesting: async () => current,
    startMutationTesting: async (_ws, _pr, input) => {
      started.push(input);
      return { runId: "m9", existing: false };
    },
    cancelMutationTesting: async () => {
      cancels++;
    },
    followMutationProgress: async function* (_ws, _pr, signal) {
      for (const event of streamed) yield event;
      if (streamThen === "end") return;
      if (streamThen === "throw") throw new Error("connection reset");
      await new Promise<void>((resolve) =>
        signal?.addEventListener("abort", () => {
          streamAborted = true;
          resolve();
        }),
      );
    },
  });
});

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

const NOTES = "Mutation testing runs the pull request's tests in a macOS sandbox.";
const state = (over: Partial<MutationTestingState>): MutationTestingState => ({
  run: null,
  headSha: HEAD,
  blocked: null,
  sandboxNotes: NOTES,
  ...over,
});

const run = (over: Partial<MutationRun>): MutationRun => ({
  id: "m1",
  headSha: HEAD,
  status: "succeeded",
  phase: "done",
  execution: { baselines: [], positiveControls: [], mutants: [], planned: 0 },
  summary: null,
  findings: null,
  error: null,
  costUsd: 0.3,
  startedAt: "",
  finishedAt: "",
  isCurrentHead: true,
  live: false,
  ...over,
});

/** Mounts on `s`; a re-read answers `reread`, which defaults to `s`. */
async function mount(s: MutationTestingState, reread: MutationTestingState = s) {
  current = reread;
  primeCache(mutationKey(pr.id), s);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  const mounted = await mountForInteraction(createElement(MutationTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("MutationTab", () => {
  it("sends a PR still waiting on setup consent to the setup prompt", async () => {
    const host = await mount(
      state({ blocked: { reason: "running this pull request's code needs your consent first" } }),
    );
    expect(textOf(host.innerHTML)).toContain("needs your consent first");
    expect(button(host, "Run mutation testing")).toBeUndefined();
    button(host, "Review the setup script…")?.click();
    expect(setupOpened).toBe(1);
  });

  it("asks a PR with no setup script to confirm running its tests, then starts", async () => {
    const host = await mount(
      state({
        blocked: {
          reason: "there is no setup script; confirm running the tests without one",
          needsTestConfirmation: true,
        },
      }),
    );
    button(host, "Run the tests without a setup script…")?.click();
    await waitFor(() => button(host, "Start mutation testing") !== undefined, "the start panel");
    const text = textOf(host.innerHTML);
    expect(text).toContain("Starting is your agreement to run this PR's tests");
    expect(text).toContain(NOTES);
    button(host, "Start mutation testing")?.click();
    await waitFor(() => started.length > 0, "the start");
    expect(started).toEqual([{ headSha: HEAD, confirmRunTests: true }]);
  });

  it("says what a pass costs and how it is sandboxed before it starts", async () => {
    const host = await mount(state({}));
    button(host, "Run mutation testing")?.click();
    await waitFor(() => button(host, "Start mutation testing") !== undefined, "the start panel");
    const text = textOf(host.innerHTML);
    expect(text).toContain("budgeted at $1.50 and may cost more");
    expect(text).toContain(NOTES);
    expect(started).toEqual([]);
    button(host, "Not now")?.click();
    await waitFor(() => button(host, "Start mutation testing") === undefined, "the panel to close");
    expect(started).toEqual([]);
  });

  it("shows a running pass phase by phase and each mutant as it lands, and cancels it", async () => {
    streamed = [
      { type: "phase", phase: "mutants" },
      {
        type: "mutant",
        result: {
          id: "m1",
          path: "src/a.ts",
          line: 3,
          oldText: "a < b",
          newText: "a <= b",
          description: "boundary moved",
          rationale: "",
          testCommandId: null,
          testFiles: [],
          outcome: "survived",
          durationMs: 1,
          testCount: 1,
          evidence: "",
        },
        index: 0,
        total: 4,
        control: false,
      },
    ];
    const host = await mount(
      state({ run: run({ status: "running", phase: "mutants", live: true }) }),
    );
    await waitFor(() => textOf(host.innerHTML).includes("1 of 4"), "the mutant to land");
    const text = textOf(host.innerHTML);
    expect(text).toContain("Testing mutants");
    expect(text).toContain("survived");
    expect(text).toContain("+ a <= b");
    button(host, "Cancel")?.click();
    await waitFor(() => cancels > 0, "the cancel");
  });

  it("offers a re-run when the pass was for an older head", async () => {
    const host = await mount(
      state({ run: run({ headSha: "c".repeat(40), isCurrentHead: false }) }),
    );
    expect(textOf(host.innerHTML)).toContain("This pass is for an older head");
  });

  it("says a failed pass failed and keeps what it found", async () => {
    const host = await mount(
      state({
        run: run({
          status: "failed",
          error: "the planning run hit its budget",
          summary: {
            killed: 1,
            survived: 0,
            timeouts: 0,
            errors: 0,
            uncovered: 0,
            equivalent: 0,
            valid: 1,
            killRate: 1,
            verdict: "inconclusive",
            notes: [],
          },
        }),
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The pass failed: the planning run hit its budget");
    expect(text).toContain("Inconclusive");
  });

  const runningRun = () => run({ status: "running", phase: "planning", live: true });

  it("stops following when the tab goes", async () => {
    await mount(state({ run: runningRun() }));
    unmount();
    unmount = () => {};
    await waitFor(() => streamAborted, "the stream to be aborted");
  });

  it("doesn't keep spinning when the stream ends without saying the pass is done", async () => {
    streamThen = "end";
    const host = await mount(state({ run: runningRun() }));
    await waitFor(
      () => textOf(host.innerHTML).includes("progress stopped coming through"),
      "the lost-track notice",
    );
    expect(button(host, "Cancel")).toBeUndefined();
  });

  it("shows why it lost the stream when the stream fails", async () => {
    streamThen = "throw";
    const host = await mount(state({ run: runningRun() }));
    await waitFor(
      () => textOf(host.innerHTML).includes("Lost track of the run: connection reset"),
      "the stream error",
    );
    expect(button(host, "Cancel")).toBeUndefined();
  });

  it("re-reads the pass when it is done and shows its report", async () => {
    streamed = [{ type: "done", status: "succeeded" }];
    streamThen = "end";
    const finished = state({
      run: run({
        summary: {
          killed: 5,
          survived: 0,
          timeouts: 0,
          errors: 0,
          uncovered: 0,
          equivalent: 0,
          valid: 5,
          killRate: 1,
          verdict: "strong",
          notes: [],
        },
      }),
    });
    const host = await mount(state({ run: runningRun() }), finished);
    await waitFor(() => textOf(host.innerHTML).includes("Strong"), "the report");
    expect(textOf(host.innerHTML)).toContain("The tests caught 5 of 5 mutants");
  });

  it("shows why a pass couldn't start", async () => {
    stubReviewApi({
      startMutationTesting: async () => {
        throw new Error("start mutation testing failed (409): the pull request has moved");
      },
    });
    const host = await mount(state({}));
    button(host, "Run mutation testing")?.click();
    await waitFor(() => button(host, "Start mutation testing") !== undefined, "the start panel");
    button(host, "Start mutation testing")?.click();
    await waitFor(
      () => textOf(host.innerHTML).includes("the pull request has moved"),
      "the start error",
    );
  });

  it("says a pass was cancelled and keeps what it found", async () => {
    const host = await mount(
      state({
        run: run({
          status: "cancelled",
          summary: {
            killed: 2,
            survived: 1,
            timeouts: 0,
            errors: 0,
            uncovered: 0,
            equivalent: 0,
            valid: 3,
            killRate: 2 / 3,
            verdict: "mixed",
            notes: [],
          },
        }),
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The pass was cancelled. Below is what it found before then.");
    expect(text).toContain("Mixed");
    expect(button(host, "Re-run")).toBeDefined();
  });

  it("says when another window is running a pass, and checks again on request", async () => {
    const host = await mount(state({ run: run({ status: "running", live: false }) }));
    expect(textOf(host.innerHTML)).toContain("running in another Yarvis window");
    expect(button(host, "Re-run")).toBeUndefined();
    current = state({ run: run({}) });
    button(host, "Check again")?.click();
    await waitFor(() => button(host, "Re-run") !== undefined, "the finished pass");
  });

  it("re-runs a pass made for an older head from the one Re-run", async () => {
    const host = await mount(
      state({ run: run({ headSha: "c".repeat(40), isCurrentHead: false }) }),
    );
    const reruns = [...host.querySelectorAll("button")].filter((b) => b.textContent === "Re-run");
    expect(reruns).toHaveLength(1);
    reruns[0]?.click();
    await waitFor(() => button(host, "Start mutation testing") !== undefined, "the start panel");
    button(host, "Start mutation testing")?.click();
    await waitFor(() => started.length > 0, "the start");
    expect(started).toEqual([{ headSha: HEAD, confirmRunTests: false }]);
  });

  it("asks again once consent is given, and the block clears", async () => {
    let setPr: (pr: ReviewWorkspacePr) => void = () => {};
    function Harness() {
      const [p, set] = useState(pr);
      setPr = set;
      return createElement(MutationTab, { ctx: { ...ctx, pr: p } });
    }
    current = state({ blocked: { reason: "setup hasn't run" } });
    primeCache(mutationKey(pr.id), current);
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    const mounted = await mountForInteraction(createElement(Harness));
    unmount = mounted.unmount;
    expect(textOf(mounted.host.innerHTML)).toContain("setup hasn't run");

    current = state({});
    await act(async () =>
      setPr({ ...pr, setupConsent: "granted", setupStatus: "succeeded", setupHeadSha: HEAD }),
    );
    await waitFor(
      () => button(mounted.host, "Run mutation testing") !== undefined,
      "the block to clear",
    );
    expect(textOf(mounted.host.innerHTML)).not.toContain("setup hasn't run");
  });

  it("offers no setup prompt while setup is running", async () => {
    primeCache(mutationKey(pr.id), state({ blocked: { reason: "setup is still running" } }));
    current = state({ blocked: { reason: "setup is still running" } });
    primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
    const mounted = await mountForInteraction(
      createElement(MutationTab, { ctx: { ...ctx, pr: { ...pr, setupStatus: "running" } } }),
    );
    unmount = mounted.unmount;
    expect(button(mounted.host, "Review the setup script…")).toBeUndefined();
  });
});
