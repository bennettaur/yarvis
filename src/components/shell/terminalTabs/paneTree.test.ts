import { describe, expect, it } from "bun:test";
import {
  allLeafIds,
  firstLeafId,
  hasPane,
  leaf,
  nextFocusAfterRemove,
  removePane,
  splitPane,
} from "./paneTree";

describe("paneTree", () => {
  it("a fresh leaf has just that id", () => {
    const tree = leaf("a");
    expect(allLeafIds(tree)).toEqual(["a"]);
    expect(firstLeafId(tree)).toBe("a");
  });

  it("splitting a leaf produces a split with the original first and the new pane second", () => {
    const split = splitPane(leaf("a"), "a", "vertical", "b");
    expect(split).toEqual({
      kind: "split",
      direction: "vertical",
      first: leaf("a"),
      second: leaf("b"),
    });
  });

  it("placeNewAfter=false puts the new pane on the first side", () => {
    const split = splitPane(leaf("a"), "a", "horizontal", "b", false);
    if (split.kind !== "split") throw new Error("expected split");
    expect(split.first).toEqual(leaf("b"));
    expect(split.second).toEqual(leaf("a"));
  });

  it("splitPane is a no-op when target is not found", () => {
    const tree = leaf("a");
    const next = splitPane(tree, "nope", "vertical", "b");
    expect(next).toBe(tree);
  });

  it("splits a nested leaf without disturbing siblings", () => {
    const tree = splitPane(leaf("a"), "a", "vertical", "b"); // a | b
    const nested = splitPane(tree, "b", "horizontal", "c"); // a | (b / c)
    expect(allLeafIds(nested)).toEqual(["a", "b", "c"]);
    if (nested.kind !== "split") throw new Error("expected split");
    expect(nested.first).toEqual(leaf("a"));
    expect(nested.second).toEqual({
      kind: "split",
      direction: "horizontal",
      first: leaf("b"),
      second: leaf("c"),
    });
  });

  it("removePane collapses the split when one side is removed", () => {
    const tree = splitPane(leaf("a"), "a", "vertical", "b");
    expect(removePane(tree, "a")).toEqual(leaf("b"));
    expect(removePane(tree, "b")).toEqual(leaf("a"));
  });

  it("removePane returns null when the only leaf is removed", () => {
    expect(removePane(leaf("a"), "a")).toBeNull();
  });

  it("removePane is a no-op when the target is not present", () => {
    const tree = splitPane(leaf("a"), "a", "vertical", "b");
    expect(removePane(tree, "nope")).toBe(tree);
  });

  it("removePane handles a deep tree", () => {
    let tree = splitPane(leaf("a"), "a", "vertical", "b"); // a | b
    tree = splitPane(tree, "b", "horizontal", "c"); // a | (b / c)
    tree = splitPane(tree, "c", "vertical", "d"); // a | (b / (c | d))
    const without = removePane(tree, "c"); // a | (b / d)
    expect(without).toEqual({
      kind: "split",
      direction: "vertical",
      first: leaf("a"),
      second: {
        kind: "split",
        direction: "horizontal",
        first: leaf("b"),
        second: leaf("d"),
      },
    });
  });

  it("nextFocusAfterRemove returns the first surviving leaf", () => {
    const tree = splitPane(leaf("a"), "a", "vertical", "b");
    expect(nextFocusAfterRemove(tree, "b")).toBe("a");
    expect(nextFocusAfterRemove(tree, "a")).toBe("b");
  });

  it("nextFocusAfterRemove returns null when the last leaf is removed", () => {
    expect(nextFocusAfterRemove(leaf("a"), "a")).toBeNull();
  });

  it("hasPane finds a leaf at any depth", () => {
    let tree = splitPane(leaf("a"), "a", "vertical", "b");
    tree = splitPane(tree, "b", "horizontal", "c");
    expect(hasPane(tree, "a")).toBe(true);
    expect(hasPane(tree, "c")).toBe(true);
    expect(hasPane(tree, "nope")).toBe(false);
  });
});
