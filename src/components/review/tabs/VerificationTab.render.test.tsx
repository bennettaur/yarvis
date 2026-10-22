import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AgentRunEvent } from "../../../lib/agentRuns";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../../lib/reviewWorkspaces/cache";
import type { LatestVerification } from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import { treeKey, verificationKey } from "./reviewData";
import type { TabContext } from "./types";
import VerificationTab from "./VerificationTab";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "octo", repo: "repo", number: 7 },
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
} as ReviewWorkspacePr;

const ctx: TabContext = {
  workspaceId: "ws",
  pr,
  prRef: pr.ref,
  diffMode: "split",
  openTab: () => {},
  openSetup: () => {},
};

let started: string[] = [];
let cancelled: string[] = [];

beforeEach(() => {
  started = [];
  cancelled = [];
  stubReviewApi({
    startVerification: async (_ws, prId) => {
      started.push(prId);
      return { runId: "r9", existing: false };
    },
    // A live run that never ends on its own, so it stays "running".
    streamAgentRun: async function* (_id, signal) {
      yield { type: "status", message: "reading the diff" } as AgentRunEvent;
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve()));
    },
    cancelAgentRun: async (id) => {
      cancelled.push(id);
    },
  });
});

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

const check = { status: "pass" as const, findings: [] };
const goodRun = {
  id: "r1",
  status: "succeeded",
  costUsd: 0.42,
  result: {
    summary: "Adds a cache in front of the user lookup.",
    mustRead: [],
    risk: { level: "low", clientImpact: "None.", mitigations: [], concerns: [] },
    completeness: check,
    tests: check,
    complexity: check,
    performance: check,
    comments: check,
  },
} as never;

const latest = (over: Partial<LatestVerification>): LatestVerification => ({
  run: null,
  headSha: pr.headSha,
  current: false,
  lastSucceeded: null,
  size: null,
  ...over,
});

async function mount(state: LatestVerification) {
  // Every read the tab makes comes from the cache, so none reaches a client.
  primeCache(verificationKey(pr.id), state);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  primeCache(treeKey(pr) ?? "", { headSha: "", paths: [] });
  const mounted = await mountForInteraction(createElement(VerificationTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("VerificationTab", () => {
  it("keeps the last good report on screen under a failed re-run", async () => {
    const host = await mount(
      latest({
        run: { id: "r2", status: "failed", error: "budget exceeded", live: false } as never,
        current: true,
        lastSucceeded: { run: goodRun, headSha: "g".repeat(40), current: false },
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The re-run failed: budget exceeded");
    expect(text).toContain("Below is the last good report, from ggggggg.");
    expect(text).toContain("Adds a cache in front of the user lookup.");
    expect(text).toContain("This report is for an older head");
  });

  it("says a run was cancelled and keeps the last good report", async () => {
    const host = await mount(
      latest({
        run: { id: "r2", status: "cancelled", live: false } as never,
        lastSucceeded: { run: goodRun, headSha: pr.headSha, current: true },
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The last run was cancelled.");
    expect(text).toContain("Adds a cache in front of the user lookup.");
    expect(text).not.toContain("older head");
  });

  it("offers a re-run when the report is for an older head", async () => {
    const host = await mount(
      latest({
        run: goodRun,
        lastSucceeded: { run: goodRun, headSha: "g".repeat(40), current: false },
      }),
    );
    expect(textOf(host.innerHTML)).toContain("This report is for an older head");
    button(host, "Re-run")?.click();
    await waitFor(() => started.length > 0, "the re-run to start");
    expect(started).toEqual(["pr1"]);
  });

  it("follows a run going here and cancels it", async () => {
    const host = await mount(latest({ run: { id: "r7", status: "running", live: true } as never }));
    await waitFor(() => button(host, "Cancel") !== undefined, "the Cancel button");
    button(host, "Cancel")?.click();
    await waitFor(() => cancelled.length > 0, "the cancel");
    expect(cancelled).toEqual(["r7"]);
  });

  it("says when another window is writing the report, and offers no second run", async () => {
    const host = await mount(
      latest({ run: { id: "r7", status: "running", live: false } as never }),
    );
    expect(textOf(host.innerHTML)).toContain("being written by another Yarvis window");
    expect(button(host, "Run verification")).toBeUndefined();
    expect(button(host, "Re-run")).toBeUndefined();
  });

  it("asks before starting a run on a large PR, and Cancel starts nothing", async () => {
    const host = await mount(latest({ size: { files: 240, changedLines: 9000, large: true } }));
    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the large-PR warning");
    expect(textOf(host.innerHTML)).toContain("This PR is large: 240 files, 9000 changed lines.");

    const cancel = [...host.querySelectorAll('[role="alert"] button')].find(
      (b) => b.textContent === "Cancel",
    ) as HTMLButtonElement;
    cancel.click();
    await waitFor(() => button(host, "Run anyway") === undefined, "the warning to close");
    expect(started).toEqual([]);

    button(host, "Run verification")?.click();
    await waitFor(() => button(host, "Run anyway") !== undefined, "the warning again");
    button(host, "Run anyway")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(started).toEqual(["pr1"]);
  });

  it("shows why a run couldn't start", async () => {
    stubReviewApi({
      startVerification: async () => {
        throw new Error("start verification report failed (409): setup hasn't run");
      },
    });
    const host = await mount(latest({}));
    button(host, "Run verification")?.click();
    await waitFor(() => textOf(host.innerHTML).includes("setup hasn't run"), "the start error");
  });
});
