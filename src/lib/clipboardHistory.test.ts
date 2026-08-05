import { describe, expect, it } from "bun:test";
import type { ClipboardHistoryItem } from "./clipboard";
import { filterHistory, screenHistory } from "./clipboardHistory";

const ITEMS: ClipboardHistoryItem[] = [
  { id: "clip-3", text: "kubectl -n production get pods", capturedAtMs: 3_000 },
  { id: "clip-2", text: "AKIAIOSFODNN7EXAMPLE", capturedAtMs: 2_000 },
  { id: "clip-1", text: "3f8a1c22-9b4e-4d2f-8a6c-1e5b7d9f0a31", capturedAtMs: 1_000 },
];

describe("screenHistory", () => {
  it("drops flagged clips and counts what it withheld", () => {
    const screened = screenHistory(ITEMS, new Map([["clip-2", "looks like an AWS access key id"]]));
    expect(screened.items.map((i) => i.id)).toEqual(["clip-3", "clip-1"]);
    expect(screened.hiddenCount).toBe(1);
  });

  it("keeps everything when nothing is flagged", () => {
    const screened = screenHistory(ITEMS, new Map());
    expect(screened.items.length).toBe(3);
    expect(screened.hiddenCount).toBe(0);
  });
});

describe("filterHistory", () => {
  it("matches clip text case-insensitively", () => {
    expect(filterHistory(ITEMS, "KUBECTL").map((i) => i.id)).toEqual(["clip-3"]);
  });

  it("returns everything for a blank query", () => {
    expect(filterHistory(ITEMS, "   ").length).toBe(3);
  });

  it("returns nothing when a query matches no clip", () => {
    expect(filterHistory(ITEMS, "nothing here")).toBeEmpty();
  });
});
