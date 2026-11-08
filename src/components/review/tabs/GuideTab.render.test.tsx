import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrGuideGraph } from "../../../lib/pr/flowDiagram";
import type { PrGuide } from "../../../lib/pr/guide";
import type { ReviewWorkspacePr } from "../../../lib/reviewWorkspaces/api";
import { mountForInteraction, textOf, waitFor } from "../../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../../test/sidecarApi";
import GuideTab from "./GuideTab";
import type { TabContext } from "./types";

const pr = {
  id: "pr1",
  title: "Cache the user lookup",
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

const graph: PrGuideGraph = {
  nodes: [
    { id: "route", kind: "endpoint", file: "src/api.ts", changed: true },
    { id: "store", kind: "function", changed: false },
  ],
  edges: [{ from: "route", to: "store", kind: "calls" }],
};

const guide = (over: Partial<PrGuide> = {}): PrGuide => ({
  headSha: "a".repeat(40),
  steps: [{ path: "src/api.ts", startLine: 10, endLine: 20, explanation: "the request arrives" }],
  currentStep: 0,
  stale: false,
  createdAt: "",
  ...over,
});

// Answers the guide route with `stored` and the viewed-files list with an
// empty one. These tests never move a step, so no progress write is answered.
function serve(stored: PrGuide) {
  stubSidecarApi({
    sidecarFetch: async (path: string) => {
      const body = path.startsWith("/api/pr/guide?") ? { guide: stored } : [];
      return new Response(JSON.stringify(body), { status: 200 });
    },
  });
}

let unmount: (() => void) | undefined;
afterEach(() => {
  unmount?.();
  unmount = undefined;
});
afterAll(() => {
  resetSidecarApi();
});

describe("GuideTab", () => {
  it("shows the flow diagram section below the current step", async () => {
    serve(guide({ graph }));
    const mounted = await mountForInteraction(createElement(GuideTab, { ctx }));
    unmount = mounted.unmount;
    await waitFor(() => textOf(mounted.host.innerHTML).includes("the request arrives"), "the step");
    const text = textOf(mounted.host.innerHTML);
    expect(text).toContain("Flow diagram");
    expect(text).toContain("2 pieces of code, 1 changed");
    expect(text.indexOf("the request arrives")).toBeLessThan(text.indexOf("Flow diagram"));
  });

  it("shows no diagram section for a guide without a graph", async () => {
    serve(guide());
    const mounted = await mountForInteraction(createElement(GuideTab, { ctx }));
    unmount = mounted.unmount;
    await waitFor(() => textOf(mounted.host.innerHTML).includes("the request arrives"), "the step");
    expect(textOf(mounted.host.innerHTML)).not.toContain("Flow diagram");
  });
});
