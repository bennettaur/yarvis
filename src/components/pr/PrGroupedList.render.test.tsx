import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import type { PrRef, PrSummary } from "../../lib/pr/types";
import { renderToHtml } from "../../test/render";

// Each row reads CI state through usePrStatus (a sidecar-backed resource). Stub
// the cache so the list renders without a transport. mock.module is
// process-global in bun, so keep the module's other exports intact.
const actualCache = await import("../../lib/pr/cache");
mock.module("../../lib/pr/cache", () => ({
  ...actualCache,
  usePrStatus: () => ({ data: null, error: null, loading: false }),
}));

const { default: PrGroupedList, groupByRepo } = await import("./PrGroupedList");

const COLLAPSED_STORAGE_KEY = "yarvis.prs.collapsedRepos";

function pr(owner: string, number: number, createdAt: string): PrSummary {
  const ref: PrRef = { provider: "github", owner, repo: "widgets", number };
  return {
    ref,
    title: `PR ${owner}#${number}`,
    url: `https://github.com/${owner}/widgets/pull/${number}`,
    author: "them",
    draft: false,
    state: "open",
    createdAt,
    updatedAt: createdAt,
  };
}

const listProps = {
  isStarred: () => false,
  onToggleStar: () => {},
  onReview: () => {},
};

const render = (prs: PrSummary[]) =>
  renderToHtml(createElement(PrGroupedList, { prs, ...listProps }));

beforeEach(() => {
  localStorage.removeItem(COLLAPSED_STORAGE_KEY);
});

describe("groupByRepo", () => {
  it("groups by display repo, newest first within and across groups", () => {
    const groups = groupByRepo([
      pr("acme", 1, "2026-07-01T00:00:00Z"),
      pr("other", 2, "2026-07-05T00:00:00Z"),
      pr("acme", 3, "2026-07-03T00:00:00Z"),
    ]);
    expect(groups.map((g) => g.repo)).toEqual(["other/widgets", "acme/widgets"]);
    expect(groups[1]!.prs.map((p) => p.ref)).toMatchObject([{ number: 3 }, { number: 1 }]);
  });
});

describe("PrGroupedList", () => {
  it("renders an empty state when there is nothing to show", async () => {
    expect(await render([])).toContain("None.");
  });

  it("shows each repo header with its PR count, expanded by default", async () => {
    const html = await render([
      pr("acme", 1, "2026-07-01T00:00:00Z"),
      pr("acme", 2, "2026-07-02T00:00:00Z"),
    ]);
    expect(html).toContain("acme/widgets");
    expect(html).toContain("(2)");
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("PR acme#1");
  });

  it("hides the rows of a repo the user has collapsed", async () => {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, JSON.stringify(["acme/widgets"]));
    const html = await render([
      pr("acme", 1, "2026-07-01T00:00:00Z"),
      pr("other", 2, "2026-07-02T00:00:00Z"),
    ]);
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("PR acme#1");
    // A different repo's collapse state is independent.
    expect(html).toContain("PR other#2");
  });

  it("ignores a corrupt collapse record rather than failing to render", async () => {
    localStorage.setItem(COLLAPSED_STORAGE_KEY, "not json");
    const html = await render([pr("acme", 1, "2026-07-01T00:00:00Z")]);
    expect(html).toContain("PR acme#1");
  });
});
