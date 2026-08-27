import { describe, expect, it } from "bun:test";
import { isStacked, needsUpdateCount } from "./stack";
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
  ...extra,
});

const stack = (entries: StackEntry[]): PrStack => ({
  trunk: "main",
  entries,
  stackNumber: null,
  source: "refs",
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
