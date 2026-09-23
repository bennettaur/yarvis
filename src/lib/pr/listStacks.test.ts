import { describe, expect, it } from "bun:test";
import { nestStacks } from "./listStacks";
import { refNumber } from "./ref";
import type { PrSummary } from "./types";

function pr(number: number, baseRef: string, headRef: string | undefined, day = number): PrSummary {
  const createdAt = `2026-07-${String(day).padStart(2, "0")}T00:00:00Z`;
  return {
    ref: { provider: "github", owner: "acme", repo: "widgets", number },
    title: `PR ${number}`,
    url: `https://github.com/acme/widgets/pull/${number}`,
    author: "me",
    draft: false,
    state: "open",
    createdAt,
    updatedAt: createdAt,
    baseRef,
    headRef,
  };
}

const shape = (prs: PrSummary[]) =>
  nestStacks(prs).map((item) => ({
    pr: item.pr.ref,
    layers: item.layers.map((l) => l.ref),
  }));

describe("nestStacks", () => {
  it("nests the layers of a stack under its bottom PR, bottom-first", () => {
    // Newest first, as the list hands them over.
    const items = shape([pr(3, "two", "three"), pr(2, "one", "two"), pr(1, "main", "one")]);
    expect(items).toMatchObject([{ pr: { number: 1 }, layers: [{ number: 2 }, { number: 3 }] }]);
  });

  it("leaves unrelated PRs as their own rows, in the order given", () => {
    const items = shape([pr(2, "main", "b"), pr(1, "main", "a")]);
    expect(items).toMatchObject([
      { pr: { number: 2 }, layers: [] },
      { pr: { number: 1 }, layers: [] },
    ]);
  });

  it("places a stack where its newest PR would have been", () => {
    const items = shape([pr(9, "one", "nine"), pr(5, "main", "five"), pr(1, "main", "one")]);
    expect(items.map((i) => refNumber(i.pr))).toEqual([1, 5]);
  });

  it("does not nest PRs whose branches are unknown", () => {
    const items = shape([
      pr(2, "one", undefined),
      { ...pr(1, "main", "one"), baseRef: undefined, headRef: undefined },
    ]);
    expect(items).toHaveLength(2);
  });

  it("orders a branching stack depth-first, oldest branch first", () => {
    // 2 and 3 both sit on 1; 3 is older, and 4 sits on 2.
    const items = shape([
      pr(4, "two", "four", 9),
      pr(2, "one", "two", 8),
      pr(3, "one", "three", 5),
      pr(1, "main", "one", 1),
    ]);
    expect(items).toMatchObject([
      { pr: { number: 1 }, layers: [{ number: 3 }, { number: 2 }, { number: 4 }] },
    ]);
  });

  it("cuts a loop of PRs at the first one listed", () => {
    const items = shape([pr(2, "one", "two"), pr(1, "two", "one")]);
    expect(items).toMatchObject([{ pr: { number: 2 }, layers: [{ number: 1 }] }]);
  });

  it("ends the walk for a longer loop and a PR leading into it", () => {
    const items = shape([
      pr(4, "three", "four"),
      pr(3, "two", "three"),
      pr(2, "one", "two"),
      pr(1, "three", "one"),
    ]);
    expect(items).toHaveLength(1);
    expect(items[0]?.layers).toHaveLength(3);
  });
});
