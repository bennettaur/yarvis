import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { AgentRunEvent } from "../../lib/agentRuns";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../lib/reviewWorkspaces/cache";
import {
  DEFAULT_SECTIONS,
  type LatestVerification,
  type ReportSection,
} from "../../lib/reviewWorkspaces/verification";
import { mountForInteraction, waitFor } from "../../test/render";
import { resetReviewApi, stubReviewApi } from "../../test/reviewWorkspacesApi";
import ReviewNav from "./ReviewNav";
import { flowDiagramKey, verificationKey } from "./tabs/reviewData";
import type { TabSpec } from "./tabs/types";

const pr = {
  id: "pr1",
  ref: { provider: "github", owner: "acme", repo: "widgets", number: 7 },
  title: "Teach the parser about tabs",
  position: 0,
  colorIndex: 0,
  status: "ready",
  worktreeStatus: "ready",
  headSha: "h".repeat(40),
  mergeBaseSha: "b".repeat(40),
  setupConsent: "declined",
  setupStatus: null,
} as ReviewWorkspacePr;

const none = { run: null, headSha: pr.headSha, current: false, lastSucceeded: null };

let unmount = () => {};
afterEach(() => {
  unmount();
  resetReviewApi();
});

async function mount(
  verification: Partial<LatestVerification>,
  opened: TabSpec[],
  over: Partial<ReviewWorkspacePr> = {},
  diagram: object = {},
) {
  primeCache(prDetailKey(pr.ref), { title: pr.title, reviewThreads: [] } as unknown as PrDetail);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  primeCache(verificationKey(pr.id), { ...none, size: null, ...verification });
  primeCache(flowDiagramKey(pr.id), { ...none, ...diagram });
  const mounted = await mountForInteraction(
    createElement(ReviewNav, {
      workspaceId: "ws",
      prs: [{ ...pr, ...over }],
      active: null,
      progress: new Map(),
      openTab: (spec) => opened.push(spec),
      onSetup: () => {},
    }),
  );
  unmount = mounted.unmount;
  return mounted.host;
}

const button = (host: HTMLElement, label: string) =>
  [...host.querySelectorAll("button")].find((b) => b.getAttribute("aria-label") === label);

describe("ReviewNav's run buttons", () => {
  it("starts a flow diagram and opens its tab", async () => {
    const started: string[] = [];
    stubReviewApi({
      startFlowDiagram: async (_ws, prId) => {
        started.push(prId);
        return { runId: "r1", existing: false };
      },
    });
    const opened: TabSpec[] = [];
    const host = await mount({}, opened);
    button(host, "Run flow diagram")?.click();
    await waitFor(() => opened.length > 0, "the diagram tab to open");
    expect(started).toEqual(["pr1"]);
    expect(opened).toEqual([{ kind: "diagram", prId: "pr1" }]);
  });

  it("re-runs verification with the last run's sections", async () => {
    const sections: (readonly ReportSection[])[] = [];
    stubReviewApi({
      startVerification: async (_ws, _prId, picked) => {
        sections.push(picked);
        return { runId: "r2", existing: false };
      },
    });
    const opened: TabSpec[] = [];
    const host = await mount(
      {
        run: { id: "r1", status: "succeeded", meta: { sections: ["tests"] } } as never,
        size: {
          files: 2,
          changedLines: 10,
          large: false,
          binary: [],
          truncated: [],
          skimmed: [],
          estimatedCostUsd: 0.4,
          sectionCostUsd: 0.04,
          defaultSections: [...DEFAULT_SECTIONS],
          budgetUsd: 2,
          overBudget: false,
        },
      },
      opened,
    );
    button(host, "Re-run verification")?.click();
    await waitFor(() => opened.length > 0, "the verification tab to open");
    expect(sections).toEqual([["tests"]]);
    expect(opened).toEqual([{ kind: "verification", prId: "pr1" }]);
  });

  it("opens the report instead of starting a run that needs confirming", async () => {
    const sections: unknown[] = [];
    stubReviewApi({
      startVerification: async (_ws, _prId, picked) => {
        sections.push(picked);
        return { runId: "r2", existing: false };
      },
    });
    const opened: TabSpec[] = [];
    const large = await mount({ size: { large: true, overBudget: false } as never }, opened);
    button(large, "Run verification")?.click();
    await waitFor(() => opened.length > 0, "the verification tab to open");
    unmount();
    // A size not known yet asks too, rather than skip the question.
    const unknown = await mount({ size: null }, opened);
    button(unknown, "Run verification")?.click();
    await waitFor(() => opened.length > 1, "the verification tab to open again");
    expect(sections).toEqual([]);
  });

  it("asks before a run over budget, even on a PR that isn't large", async () => {
    const sections: unknown[] = [];
    stubReviewApi({
      startVerification: async (_ws, _prId, picked) => {
        sections.push(picked);
        return { runId: "r2", existing: false };
      },
    });
    const opened: TabSpec[] = [];
    const host = await mount(
      {
        size: {
          files: 2,
          changedLines: 10,
          large: false,
          binary: [],
          truncated: [],
          skimmed: [],
          estimatedCostUsd: 3,
          sectionCostUsd: 0.04,
          defaultSections: [...DEFAULT_SECTIONS],
          budgetUsd: 1,
          overBudget: true,
        },
      },
      opened,
    );
    button(host, "Run verification")?.click();
    await waitFor(() => opened.length > 0, "the verification tab to open");
    expect(sections).toEqual([]);
  });

  it("shows why a run couldn't start, and lets it be tried again", async () => {
    stubReviewApi({
      startFlowDiagram: async () => {
        throw new Error("The checkout isn't ready");
      },
    });
    const opened: TabSpec[] = [];
    const host = await mount({}, opened);
    button(host, "Run flow diagram")?.click();
    await waitFor(
      () => host.textContent?.includes("The checkout isn't ready") ?? false,
      "the error",
    );
    expect(button(host, "Run flow diagram")?.disabled).toBe(false);
    expect(opened).toEqual([]);
  });

  it("doesn't spin for a run another window owns, and Run joins it", async () => {
    const streamed: string[] = [];
    const started: string[] = [];
    stubReviewApi({
      streamAgentRun: async function* (id) {
        streamed.push(id);
        yield { type: "done", status: "succeeded" } as AgentRunEvent;
      },
      startFlowDiagram: async (_ws, prId) => {
        started.push(prId);
        return { runId: "r1", existing: true };
      },
    });
    const opened: TabSpec[] = [];
    const host = await mount({}, opened, {}, { run: { id: "r1", status: "running", live: false } });
    const run = button(host, "Re-run flow diagram");
    expect(run?.disabled).toBe(false);
    run?.click();
    await waitFor(() => opened.length > 0, "the diagram tab to open");
    expect(started).toEqual(["pr1"]);
    expect(streamed).toEqual([]);
  });

  it("can't run before the checkout is ready", async () => {
    const host = await mount({}, [], { worktreeStatus: "checking-out" });
    expect(button(host, "Run verification")?.disabled).toBe(true);
    expect(button(host, "Run flow diagram")?.disabled).toBe(true);
  });

  it("follows a live run to its end, so the button is free again", async () => {
    let ended = false;
    let end = () => {};
    const ending = new Promise<void>((resolve) => {
      end = resolve;
    });
    stubReviewApi({
      streamAgentRun: async function* () {
        await ending;
        ended = true;
        yield { type: "done", status: "succeeded" } as AgentRunEvent;
      },
      latestFlowDiagram: async () => ({
        ...none,
        run: { id: "r1", status: ended ? "succeeded" : "running", live: !ended } as never,
      }),
    });
    const host = await mount({}, [], {}, { run: { id: "r1", status: "running", live: true } });
    expect(button(host, "Re-run flow diagram")?.disabled).toBe(true);
    end();
    await waitFor(
      () => button(host, "Re-run flow diagram")?.disabled === false,
      "the button once the run ends",
    );
  });
});
