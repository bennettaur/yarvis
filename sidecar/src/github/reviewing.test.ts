import { describe, expect, it } from "bun:test";
import type { PrInvolvement, ReviewerState } from "../pr/types.ts";
import { isReviewComplete, partitionInvolvement, viewedRefsFromEvents } from "./reviewing.ts";

function involvement(
  overrides: {
    number?: number;
    author?: string;
    state?: string;
    merged?: boolean;
    updatedAt?: string;
    myReviewStates?: ReviewerState[];
  } = {},
): PrInvolvement {
  const number = overrides.number ?? 1;
  return {
    summary: {
      number,
      title: `PR ${number}`,
      url: `https://github.com/o/r/pull/${number}`,
      owner: "o",
      repo: "r",
      author: overrides.author ?? "someone",
      draft: false,
      state: overrides.state ?? "open",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: overrides.updatedAt ?? "2026-07-01T00:00:00Z",
    },
    merged: overrides.merged ?? false,
    myReviewStates: overrides.myReviewStates ?? [],
  };
}

describe("viewedRefsFromEvents", () => {
  it("keeps GitHub refs in order, deduplicated", () => {
    const refs = viewedRefsFromEvents([
      { payload: { ref: { provider: "github", owner: "o", repo: "r", number: 2 } } },
      { payload: { ref: { provider: "github", owner: "o", repo: "r", number: 1 } } },
      { payload: { ref: { provider: "github", owner: "o", repo: "r", number: 2 } } },
    ]);
    expect(refs).toEqual([
      { owner: "o", repo: "r", number: 2 },
      { owner: "o", repo: "r", number: 1 },
    ]);
  });

  it("drops Azure refs and unusable payloads", () => {
    expect(
      viewedRefsFromEvents([
        { payload: { ref: { provider: "azure", org: "x", project: "p", repo: "r", prId: 3 } } },
        { payload: null },
        { payload: {} },
        { payload: { ref: { provider: "github", owner: "o", repo: "r" } } },
        { payload: { ref: { provider: "github", owner: "o", repo: "r", number: "4" } } },
      ]),
    ).toEqual([]);
  });
});

describe("isReviewComplete", () => {
  it("counts merged and closed PRs as done", () => {
    expect(isReviewComplete(involvement({ merged: true, state: "closed" }))).toBe(true);
    expect(isReviewComplete(involvement({ state: "closed" }))).toBe(true);
  });

  it("counts the viewer's own approval as done", () => {
    expect(isReviewComplete(involvement({ myReviewStates: ["approved"] }))).toBe(true);
    expect(isReviewComplete(involvement({ myReviewStates: ["commented", "approved"] }))).toBe(true);
  });

  it("puts the viewer back on the hook when a later verdict supersedes an approval", () => {
    expect(
      isReviewComplete(involvement({ myReviewStates: ["approved", "changes_requested"] })),
    ).toBe(false);
  });

  it("treats an open PR the viewer hasn't ruled on as outstanding", () => {
    expect(isReviewComplete(involvement())).toBe(false);
    expect(isReviewComplete(involvement({ myReviewStates: ["commented"] }))).toBe(false);
  });
});

describe("partitionInvolvement", () => {
  it("splits the two halves, newest-updated first", () => {
    const { inProgress, complete } = partitionInvolvement(
      [
        involvement({ number: 1, updatedAt: "2026-07-01T00:00:00Z" }),
        involvement({ number: 2, updatedAt: "2026-07-05T00:00:00Z" }),
        involvement({ number: 3, merged: true, updatedAt: "2026-07-02T00:00:00Z" }),
        involvement({ number: 4, myReviewStates: ["approved"], updatedAt: "2026-07-06T00:00:00Z" }),
      ],
      "me",
    );
    expect(inProgress.map((i) => i.summary.number)).toEqual([2, 1]);
    expect(complete.map((i) => i.summary.number)).toEqual([4, 3]);
  });

  it("drops the viewer's own PRs, which the viewed-event refs can include", () => {
    const { inProgress, complete } = partitionInvolvement(
      [involvement({ number: 1, author: "me" }), involvement({ number: 2, author: "them" })],
      "me",
    );
    expect(inProgress.map((i) => i.summary.number)).toEqual([2]);
    expect(complete).toEqual([]);
  });
});
