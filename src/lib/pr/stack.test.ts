import { describe, expect, it } from "bun:test";
import { isStacked, layerIndexOf, needsUpdateCount } from "./stack";
import type { PrStack, StackEntry } from "./types";

const entry = (number: number, extra: Partial<StackEntry> = {}): StackEntry => ({
  ref: { provider: "github", owner: "o", repo: "r", number },
  number,
  title: `pr ${number}`,
  url: "",
  baseRef: "",
  headRef: `branch-${number}`,
  state: "open",
  merged: false,
  draft: false,
  queued: false,
  checks: { total: 0, success: 0, failure: 0, pending: 0 },
  reviewDecision: null,
  isCurrent: false,
  needsUpdate: false,
  statusKnown: true,
  ...extra,
});

const stack = (entries: StackEntry[]): PrStack => ({
  trunk: "main",
  entries,
  stackNumber: null,
  truncated: false,
});

describe("isStacked", () => {
  // The sidecar answers null only when the provider has no stacks at all, so a
  // one-entry stack is the ordinary "this PR isn't stacked" — and a section
  // repeating the open PR back at the reader is worse than no section.
  it("treats a lone pull request as not stacked", () => {
    expect(isStacked(stack([entry(1)]))).toBe(false);
    expect(isStacked(stack([entry(1), entry(2)]))).toBe(true);
    expect(isStacked(null)).toBe(false);
  });
});

describe("needsUpdateCount", () => {
  it("counts the layers whose base has moved underneath them", () => {
    expect(needsUpdateCount(stack([entry(1), entry(2, { needsUpdate: true }), entry(3)]))).toBe(1);
    expect(needsUpdateCount(null)).toBe(0);
  });
});

describe("layerIndexOf", () => {
  // The stack is fetched once per layer and each copy marks its own subject
  // with `isCurrent`, so the review page positions the reader from the ref it
  // is showing — otherwise the highlight lags a round trip behind the click.
  it("finds a layer by ref regardless of which layer the stack was fetched for", () => {
    const s = stack([entry(1, { isCurrent: true }), entry(2), entry(3)]);

    expect(layerIndexOf(s, entry(3).ref)).toBe(2);
    expect(layerIndexOf(s, entry(1).ref)).toBe(0);
  });

  it("reports a pull request that is not one of the layers as absent", () => {
    expect(layerIndexOf(stack([entry(1), entry(2)]), entry(9).ref)).toBe(-1);
  });

  // A branch `gh stack` tracks before a PR exists carries number 0, and every
  // such layer would otherwise collide with any other on the same number.
  it("never matches a branch that has no pull request", () => {
    const s = stack([entry(1), entry(0)]);

    expect(layerIndexOf(s, entry(0).ref)).toBe(-1);
  });
});
