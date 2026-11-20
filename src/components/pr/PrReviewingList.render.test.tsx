import { afterAll, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrInvolvement, ReviewerState } from "../../lib/pr/types";
import { resetPrCache, stubPrCache } from "../../test/prFiles";
import { renderToHtml } from "../../test/render";

// Each row reads CI state through usePrStatus (a sidecar-backed resource).
// Stub it so the list renders without a transport.
stubPrCache({
  usePrStatus: () => ({
    data: null,
    error: null,
    loading: false,
    refreshing: false,
    refresh: async () => {},
  }),
});
afterAll(resetPrCache);

const { default: PrReviewingList } = await import("./PrReviewingList");

function involvement(
  number: number,
  over: { merged?: boolean; state?: string; myReviewStates?: ReviewerState[] } = {},
): PrInvolvement {
  return {
    summary: {
      ref: { provider: "github", owner: "acme", repo: "widgets", number },
      title: `PR ${number}`,
      url: `https://github.com/acme/widgets/pull/${number}`,
      author: "them",
      draft: false,
      state: over.state ?? "open",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-01T00:00:00Z",
    },
    merged: over.merged ?? false,
    myReviewStates: over.myReviewStates ?? [],
  };
}

const listProps = {
  isStarred: () => false,
  onToggleStar: () => {},
  onReview: () => {},
};

describe("PrReviewingList", () => {
  it("shows both halves with their counts, and starts Complete collapsed", async () => {
    const html = await renderToHtml(
      createElement(PrReviewingList, {
        list: {
          inProgress: [involvement(1)],
          complete: [involvement(2, { merged: true }), involvement(3, { state: "closed" })],
        },
        listProps,
      }),
    );
    expect(html).toContain("In progress");
    expect(html).toContain("(1)");
    expect(html).toContain("Complete");
    expect(html).toContain("(2)");
    // `open` is only present on the In progress <details>.
    expect(html.match(/<details open=""/g)?.length).toBe(1);
  });

  it("annotates rows with why they count as done, or what the user last said", async () => {
    const html = await renderToHtml(
      createElement(PrReviewingList, {
        list: {
          inProgress: [
            involvement(1, { myReviewStates: ["commented"] }),
            involvement(2, { myReviewStates: ["approved", "changes_requested"] }),
          ],
          complete: [
            involvement(3, { merged: true }),
            involvement(4, { myReviewStates: ["approved"] }),
          ],
        },
        listProps,
      }),
    );
    expect(html).toContain("you commented");
    expect(html).toContain("you requested changes");
    expect(html).toContain("merged");
    expect(html).toContain("you approved");
  });
});
