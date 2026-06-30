import { describe, expect, it } from "bun:test";
import type { PrDetail, PrSummary } from "../../lib/pr/types";
import { derivePrUiStatus } from "./PrFloatingHeader";

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
});
