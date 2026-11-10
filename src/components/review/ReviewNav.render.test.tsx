import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { prDetailKey } from "../../lib/pr/cache";
import type { PrDetail } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import type { ReviewWorkspacePr } from "../../lib/reviewWorkspaces/api";
import { changedFilesKey } from "../../lib/reviewWorkspaces/cache";
import type { LatestVerification, ReportSection } from "../../lib/reviewWorkspaces/verification";
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

async function mount(verification: Partial<LatestVerification>, opened: TabSpec[]) {
  primeCache(prDetailKey(pr.ref), { title: pr.title, reviewThreads: [] } as unknown as PrDetail);
  primeCache(changedFilesKey(pr) ?? "", { headSha: "", mergeBaseSha: "", files: [] });
  primeCache(verificationKey(pr.id), { ...none, size: null, ...verification });
  primeCache(flowDiagramKey(pr.id), none);
  const mounted = await mountForInteraction(
    createElement(ReviewNav, {
      workspaceId: "ws",
      prs: [pr],
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
      { run: { id: "r1", status: "succeeded", meta: { sections: ["tests"] } } as never },
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
    const host = await mount({ size: { large: true, overBudget: false } as never }, opened);
    button(host, "Run verification")?.click();
    await waitFor(() => opened.length > 0, "the verification tab to open");
    expect(sections).toEqual([]);
  });
});
