import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { primeCache } from "../../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import type { LatestFlowDiagram } from "../../../lib/reviewWorkspaces/flowDiagram";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
import DiagramTab from "./DiagramTab";
import { flowDiagramKey } from "./reviewData";
import type { TabContext } from "./types";

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
    startFlowDiagram: async (_ws, prId) => {
      started.push(prId);
      return { runId: "r9", existing: false };
    },
    // A live run that never ends on its own, so it stays "running".
    streamAgentRun: async function* (_id, signal) {
      yield { type: "tool", id: "t1", name: "Grep", summary: "validateOrder", subagentId: null };
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

const diagram = {
  title: "How an order is saved",
  explanation: "POST /orders validates, then writes.",
  mermaid: "",
};

const latest = (over: Partial<LatestFlowDiagram>): LatestFlowDiagram => ({
  run: null,
  headSha: pr.headSha,
  current: false,
  lastSucceeded: null,
  ...over,
});

async function mount(state: LatestFlowDiagram) {
  primeCache(flowDiagramKey(pr.id), state);
  const mounted = await mountForInteraction(createElement(DiagramTab, { ctx }));
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.textContent === label);

describe("DiagramTab", () => {
  it("explains the diagram and generates one only when asked", async () => {
    const host = await mount(latest({}));
    expect(textOf(host.innerHTML)).toContain("draws it as a flowchart");
    expect(started).toEqual([]);
    button(host, "Generate diagram")?.click();
    await waitFor(() => started.length > 0, "the run to start");
    expect(started).toEqual(["pr1"]);
  });

  it("follows a running diagram's activity, and cancels it", async () => {
    const host = await mount(
      latest({ run: { id: "r1", status: "running", live: true } as never, current: true }),
    );
    await waitFor(() => textOf(host.innerHTML).includes("Grep validateOrder"), "the activity");
    expect(textOf(host.innerHTML)).toContain("Tracing the flow");
    button(host, "Cancel")?.click();
    await waitFor(() => cancelled.length > 0, "the cancel");
    expect(cancelled).toEqual(["r1"]);
  });

  it("keeps the last diagram on screen under a failed re-run, marked as an older head's", async () => {
    const host = await mount(
      latest({
        run: { id: "r2", status: "failed", error: "timed out", live: false } as never,
        current: true,
        lastSucceeded: {
          run: { id: "r1", status: "succeeded", result: diagram, costUsd: 0.12 } as never,
          headSha: "g".repeat(40),
          current: false,
        },
      }),
    );
    const text = textOf(host.innerHTML);
    expect(text).toContain("The re-run failed: timed out");
    expect(text).toContain("How an order is saved");
    expect(text).toContain("This diagram is for an older head");
    expect(button(host, "Re-run")).toBeDefined();
  });
});
