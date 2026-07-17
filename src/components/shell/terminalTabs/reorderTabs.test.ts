import { describe, expect, it } from "bun:test";
import { reorderTabs } from "./reorderTabs";

const tab = (id: string) => ({ id });

describe("reorderTabs", () => {
  it("moves a tab before a later target", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "a", "c", "before").map((t) => t.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("moves a tab after a later target", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "a", "c", "after").map((t) => t.id)).toEqual(["b", "c", "a", "d"]);
  });

  it("moves a tab before an earlier target", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "d", "b", "before").map((t) => t.id)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves a tab after an earlier target", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "d", "b", "after").map((t) => t.id)).toEqual(["a", "b", "d", "c"]);
  });

  it("returns the same array when the drop would be a no-op", () => {
    const tabs = [tab("a"), tab("b"), tab("c")];
    // Dropping "b" before "c" leaves it where it already is.
    expect(reorderTabs(tabs, "b", "c", "before")).toBe(tabs);
    // Dropping "b" after "a" leaves it where it already is.
    expect(reorderTabs(tabs, "b", "a", "after")).toBe(tabs);
    // Dropping onto itself is a no-op.
    expect(reorderTabs(tabs, "b", "b", "before")).toBe(tabs);
  });

  it("returns the same array when an id is unknown", () => {
    const tabs = [tab("a"), tab("b")];
    expect(reorderTabs(tabs, "x", "a", "before")).toBe(tabs);
    expect(reorderTabs(tabs, "a", "x", "before")).toBe(tabs);
  });

  it("drops a tab before the first tab", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "d", "a", "before").map((t) => t.id)).toEqual(["d", "a", "b", "c"]);
  });

  it("drops a tab after the last tab", () => {
    const tabs = [tab("a"), tab("b"), tab("c"), tab("d")];
    expect(reorderTabs(tabs, "a", "d", "after").map((t) => t.id)).toEqual(["b", "c", "d", "a"]);
  });

  it("swaps adjacent tabs in both directions", () => {
    const tabs = [tab("a"), tab("b")];
    expect(reorderTabs(tabs, "a", "b", "after").map((t) => t.id)).toEqual(["b", "a"]);
    expect(reorderTabs(tabs, "b", "a", "before").map((t) => t.id)).toEqual(["b", "a"]);
  });

  it("handles a single-tab list as a self-drop no-op", () => {
    const tabs = [tab("a")];
    expect(reorderTabs(tabs, "a", "a", "before")).toBe(tabs);
    expect(reorderTabs(tabs, "a", "a", "after")).toBe(tabs);
  });

  it("returns the same array for an empty list", () => {
    const tabs: { id: string }[] = [];
    expect(reorderTabs(tabs, "a", "b", "before")).toBe(tabs);
  });
});
