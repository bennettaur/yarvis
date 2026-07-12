import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../lib/pr/types";
import { derivePrUiStatus, mergeControlsFor } from "./PrFloatingHeader";

const summary = (overrides: Partial<PrSummary> = {}): PrSummary => ({
  ref: { provider: "github", owner: "octo", repo: "repo", number: 1 },
  title: "t",
  url: "https://example/p/1",
  author: "me",
  draft: false,
  state: "open",
  createdAt: "",
  updatedAt: "",
  ...overrides,
});

const detail = (overrides: Partial<PrDetail> = {}): PrDetail => ({
  number: 1,
  title: "t",
  body: "",
  state: "open",
  draft: false,
  author: "me",
  baseRef: "main",
  headRef: "feat",
  additions: 0,
  deletions: 0,
  mergeable: "UNKNOWN",
  mergeMethods: ["MERGE", "SQUASH", "REBASE"],
  autoMergeEnabled: false,
  canEnableAutoMerge: false,
  canDisableAutoMerge: false,
  checks: [],
  reviewThreads: [],
  ...overrides,
});

describe("derivePrUiStatus", () => {
  it("returns ci_failing when any completed check has a non-success conclusion, even on a draft", async () => {
    const s = derivePrUiStatus(
      detail({
        draft: true,
        checks: [{ name: "c", status: "COMPLETED", conclusion: "FAILURE", url: null }],
      }),
      summary({ draft: true }),
    );
    expect(s).toBe("ci_failing");
  });

  it("treats NEUTRAL and SKIPPED conclusions as non-failing", async () => {
    const s = derivePrUiStatus(
      detail({
        mergeable: "MERGEABLE",
        checks: [
          { name: "a", status: "COMPLETED", conclusion: "NEUTRAL", url: null },
          { name: "b", status: "COMPLETED", conclusion: "SKIPPED", url: null },
          { name: "c", status: "COMPLETED", conclusion: "SUCCESS", url: null },
        ],
      }),
      summary(),
    );
    expect(s).toBe("ready_to_merge");
  });

  it("falls back to the summary's draft flag when detail hasn't loaded", () => {
    expect(derivePrUiStatus(null, summary({ draft: true }))).toBe("draft");
    expect(derivePrUiStatus(null, summary({ draft: false }))).toBe("awaiting_review");
  });

  it("returns awaiting_review when all checks pass but mergeable isn't MERGEABLE", () => {
    const s = derivePrUiStatus(
      detail({
        mergeable: "CONFLICTING",
        checks: [{ name: "a", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
      }),
      summary(),
    );
    expect(s).toBe("awaiting_review");
  });

  it("returns awaiting_review when checks are still pending", () => {
    const s = derivePrUiStatus(
      detail({
        mergeable: "MERGEABLE",
        checks: [{ name: "a", status: "IN_PROGRESS", conclusion: null, url: null }],
      }),
      summary(),
    );
    expect(s).toBe("awaiting_review");
  });

  it("returns ready_to_merge only when no pending and mergeable is MERGEABLE", () => {
    const s = derivePrUiStatus(
      detail({
        mergeable: "MERGEABLE",
        checks: [{ name: "a", status: "COMPLETED", conclusion: "SUCCESS", url: null }],
      }),
      summary(),
    );
    expect(s).toBe("ready_to_merge");
  });

  it("returns merged for a github MERGED state, regardless of CI history", () => {
    // A merged PR may still have failing checks recorded from before merge; the
    // terminal state takes priority so the toolbar doesn't offer to approve it.
    const s = derivePrUiStatus(
      detail({
        state: "MERGED",
        checks: [{ name: "a", status: "COMPLETED", conclusion: "FAILURE", url: null }],
      }),
      summary({ state: "closed" }),
    );
    expect(s).toBe("merged");
  });

  it("returns merged when only the summary reports it (workspace poller cache)", () => {
    // Coming from the workspace checks panel, detail isn't loaded yet; the
    // summary's `state` field (set by the poller to "merged") is the only signal.
    const s = derivePrUiStatus(null, summary({ state: "merged" }));
    expect(s).toBe("merged");
  });

  it("returns merged for an azure `completed` state", () => {
    const s = derivePrUiStatus(detail({ state: "completed" }), summary({ state: "completed" }));
    expect(s).toBe("merged");
  });

  it("returns closed for a closed-but-not-merged PR", () => {
    const s = derivePrUiStatus(detail({ state: "CLOSED" }), summary({ state: "closed" }));
    expect(s).toBe("closed");
  });

  it("returns closed for an azure `abandoned` state", () => {
    const s = derivePrUiStatus(detail({ state: "abandoned" }), summary({ state: "abandoned" }));
    expect(s).toBe("closed");
  });
});

describe("mergeControlsFor", () => {
  it("offers nothing while detail is still loading", () => {
    expect(mergeControlsFor(null, "ready_to_merge")).toEqual({
      merge: false,
      enableAuto: false,
      disableAuto: false,
    });
  });

  it("offers a merge button once the PR is ready to merge", () => {
    const controls = mergeControlsFor(detail({ canEnableAutoMerge: true }), "ready_to_merge");
    expect(controls).toEqual({ merge: true, enableAuto: false, disableAuto: false });
  });

  it("offers enable-auto-merge when the PR isn't ready but the viewer may arm it", () => {
    const controls = mergeControlsFor(detail({ canEnableAutoMerge: true }), "awaiting_review");
    expect(controls).toEqual({ merge: false, enableAuto: true, disableAuto: false });
  });

  it("offers only cancel once auto-merge is already armed", () => {
    const controls = mergeControlsFor(
      detail({ autoMergeEnabled: true, canDisableAutoMerge: true, canEnableAutoMerge: false }),
      "awaiting_review",
    );
    expect(controls).toEqual({ merge: false, enableAuto: false, disableAuto: true });
  });

  it("offers nothing when the repo exposes no merge methods (e.g. Azure)", () => {
    const controls = mergeControlsFor(
      detail({ mergeMethods: [], canEnableAutoMerge: true }),
      "ready_to_merge",
    );
    expect(controls).toEqual({ merge: false, enableAuto: false, disableAuto: false });
  });

  it("offers nothing on a terminal PR even if the detail still says mergeable", () => {
    expect(mergeControlsFor(detail({ canEnableAutoMerge: true }), "merged")).toEqual({
      merge: false,
      enableAuto: false,
      disableAuto: false,
    });
    expect(mergeControlsFor(detail({ canEnableAutoMerge: true }), "closed")).toEqual({
      merge: false,
      enableAuto: false,
      disableAuto: false,
    });
  });

  it("offers nothing when the viewer lacks permission to arm auto-merge", () => {
    const controls = mergeControlsFor(detail({ canEnableAutoMerge: false }), "awaiting_review");
    expect(controls).toEqual({ merge: false, enableAuto: false, disableAuto: false });
  });

  it("offers nothing when auto-merge is armed but the viewer can't cancel it", () => {
    const controls = mergeControlsFor(
      detail({ autoMergeEnabled: true, canDisableAutoMerge: false }),
      "awaiting_review",
    );
    expect(controls).toEqual({ merge: false, enableAuto: false, disableAuto: false });
  });
});
