import { beforeEach, describe, expect, it } from "bun:test";
import {
  activeTab,
  adjacentPath,
  closeTab,
  cycleTab,
  emptyLayout,
  loadLayout,
  moveActiveToOtherGroup,
  moveTab,
  openTab,
  parseLayout,
  pruneTabs,
  reorderInGroup,
  saveLayout,
  serializeLayout,
  type TabLayout,
} from "./tabLayout";
import { type TabSpec, tabId } from "./types";

const desc = (prId = "a"): TabSpec => ({ kind: "description", prId });
const comments = (prId = "a"): TabSpec => ({ kind: "comments", prId });
const diff = (path: string, prId = "a", revealLine?: number): TabSpec =>
  revealLine === undefined
    ? { kind: "diff", prId, path }
    : { kind: "diff", prId, path, revealLine };

const ids = (layout: TabLayout, group = 0) => layout.groups[group]!.tabs.map(tabId);
const open = (...specs: TabSpec[]) =>
  specs.reduce((layout, spec) => openTab(layout, spec), emptyLayout());

describe("openTab", () => {
  it("opens a tab once and focuses it when asked again", () => {
    const layout = openTab(open(desc(), diff("x.ts")), desc());
    expect(ids(layout)).toEqual(["description:a", "diff:a:x.ts"]);
    expect(layout.groups[0]!.activeId).toBe("description:a");
  });

  it("keeps static tabs to the left in a fixed order, files after in opening order", () => {
    const layout = open(diff("b.ts"), comments(), diff("a.ts"), desc(), desc("b"));
    expect(ids(layout)).toEqual([
      "description:a",
      "description:b",
      "comments:a",
      "diff:a:b.ts",
      "diff:a:a.ts",
    ]);
  });

  it("hands a new line to a file that is already open, with a new nonce each time", () => {
    const once = openTab(open(diff("x.ts"), desc()), diff("x.ts", "a", 42));
    expect(activeTab(once)).toEqual({
      kind: "diff",
      prId: "a",
      path: "x.ts",
      revealLine: 42,
      revealNonce: 1,
    });
    expect(ids(once)).toHaveLength(2);
    // The same line again still has to scroll there again.
    const twice = openTab(once, diff("x.ts", "a", 42));
    expect(activeTab(twice)).toEqual({
      kind: "diff",
      prId: "a",
      path: "x.ts",
      revealLine: 42,
      revealNonce: 2,
    });
    // Opening without a line keeps where the tab was.
    expect(activeTab(openTab(twice, diff("x.ts")))).toEqual(activeTab(twice));
  });

  it("focuses a tab open in the other group instead of opening a second copy", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    const back = openTab({ ...split, focusedGroup: 0 }, diff("x.ts"));
    expect(back.groups).toHaveLength(2);
    expect(back.focusedGroup).toBe(1);
    expect(ids(back, 1)).toEqual(["diff:a:x.ts"]);
  });

  it("treats the same path as different tabs per PR and per kind", () => {
    const layout = open(diff("x.ts", "a"), diff("x.ts", "b"), {
      kind: "file",
      prId: "a",
      path: "x.ts",
    });
    expect(ids(layout)).toHaveLength(3);
  });
});

describe("openTab into groups", () => {
  it("opens into the focused second group", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    const layout = openTab(split, diff("y.ts"));
    expect(ids(layout, 1)).toEqual(["diff:a:x.ts", "diff:a:y.ts"]);
    expect(layout.focusedGroup).toBe(1);
  });

  it("creates the second group when asked for one that doesn't exist", () => {
    const layout = openTab(open(desc()), diff("x.ts"), 1);
    expect(layout.groups).toHaveLength(2);
    expect(ids(layout, 1)).toEqual(["diff:a:x.ts"]);
    expect(layout.groups.map((g) => g.key)).toEqual(["a", "b"]);
  });
});

describe("closeTab", () => {
  it("shows the right-hand neighbour, or the left one at the end", () => {
    const layout = open(diff("1"), diff("2"), diff("3"));
    const middle = closeTab(openTab(layout, diff("2")), "diff:a:2");
    expect(middle.groups[0]!.activeId).toBe("diff:a:3");
    const last = closeTab(layout, "diff:a:3");
    expect(last.groups[0]!.activeId).toBe("diff:a:2");
  });

  it("folds the split when a group's last tab closes", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    const folded = closeTab(split, "diff:a:x.ts");
    expect(folded.groups).toHaveLength(1);
    expect(folded.focusedGroup).toBe(0);
    expect(ids(folded)).toEqual(["description:a"]);
  });

  it("leaves one empty group when everything is closed", () => {
    expect(closeTab(open(desc()), "description:a")).toEqual(emptyLayout());
  });
});

describe("split view", () => {
  it("moves the showing tab to a second group and focuses it", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    expect(ids(split, 0)).toEqual(["description:a"]);
    expect(ids(split, 1)).toEqual(["diff:a:x.ts"]);
    expect(split.focusedGroup).toBe(1);
  });

  it("won't split off a group's only tab, which would leave nothing beside it", () => {
    const one = open(desc());
    expect(moveActiveToOtherGroup(one).groups).toHaveLength(1);
  });

  it("moves back, folding the emptied group", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    const back = moveActiveToOtherGroup(split);
    expect(back.groups).toHaveLength(1);
    expect(ids(back)).toEqual(["description:a", "diff:a:x.ts"]);
  });

  it("lands in the right group when moving out folds the source group away", () => {
    // b's group is the second; moving its only tab into the first folds it.
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts")));
    const keyOfSurvivor = split.groups[0]?.key;
    const moved = moveTab(split, "diff:a:x.ts", 0);
    expect(moved.groups).toHaveLength(1);
    expect(ids(moved)).toEqual(["description:a", "diff:a:x.ts"]);
    expect(moved.groups[0]?.key).toBe(keyOfSurvivor);
    // And from the first group into the second: the target's index shifts down.
    const back = moveActiveToOtherGroup(open(diff("1"), diff("2")));
    const folded = moveTab({ ...back, focusedGroup: 0 }, "diff:a:1", 1);
    expect(folded.groups).toHaveLength(1);
    expect(ids(folded)).toEqual(["diff:a:2", "diff:a:1"]);
    expect(folded.focusedGroup).toBe(0);
  });

  it("drops a moved tab before the tab it was dropped on", () => {
    const split = moveActiveToOtherGroup(open(diff("1"), diff("2"), diff("3")));
    const moved = moveTab(split, "diff:a:1", 1, "diff:a:3");
    expect(ids(moved, 1)).toEqual(["diff:a:1", "diff:a:3"]);
  });
});

describe("cycleTab and reorderInGroup", () => {
  it("cycles within the second group when it has focus", () => {
    let layout = moveActiveToOtherGroup(open(desc(), diff("1")));
    layout = openTab(layout, diff("2"));
    expect(cycleTab(layout, 1).groups[1]?.activeId).toBe("diff:a:1");
    expect(cycleTab(layout, 1).groups[0]?.activeId).toBe("description:a");
  });

  it("cycles round the focused group", () => {
    const layout = open(diff("1"), diff("2"));
    expect(cycleTab(layout, 1).groups[0]!.activeId).toBe("diff:a:1");
    expect(cycleTab(layout, -1).groups[0]!.activeId).toBe("diff:a:1");
  });

  it("reorders files but keeps static tabs pinned", () => {
    const layout = open(desc(), diff("1"), diff("2"));
    expect(ids(reorderInGroup(layout, 0, "diff:a:2", "diff:a:1", "before"))).toEqual([
      "description:a",
      "diff:a:2",
      "diff:a:1",
    ]);
    expect(ids(reorderInGroup(layout, 0, "diff:a:2", "description:a", "before"))).toEqual([
      "description:a",
      "diff:a:2",
      "diff:a:1",
    ]);
  });
});

describe("pruneTabs", () => {
  it("folds a split whose group held only the removed PR's tabs", () => {
    const split = moveActiveToOtherGroup(open(desc("a"), desc("b")));
    const pruned = pruneTabs(split, new Set(["a"]));
    expect(pruned.groups).toHaveLength(1);
    expect(ids(pruned)).toEqual(["description:a"]);
    expect(pruned.focusedGroup).toBe(0);
  });

  it("closes the tabs of PRs that left the workspace", () => {
    const layout = open(desc("a"), desc("b"), diff("x", "b"));
    expect(ids(pruneTabs(layout, new Set(["a"])))).toEqual(["description:a"]);
  });
});

describe("persistence", () => {
  beforeEach(() => localStorage.clear());

  it("round-trips groups, the active tabs, focus and ratio, without line jumps", () => {
    const split = moveActiveToOtherGroup(open(desc(), diff("x.ts", "a", 12)));
    const layout = { ...split, ratio: 0.3 };
    saveLayout("ws1", layout);
    const loaded = loadLayout("ws1");
    expect(loaded.groups.map((g) => g.activeId)).toEqual(["description:a", "diff:a:x.ts"]);
    expect(loaded.focusedGroup).toBe(1);
    expect(loaded.ratio).toBe(0.3);
    expect(activeTab(loaded)).toEqual(diff("x.ts"));
    expect(loadLayout("other")).toEqual(emptyLayout());
  });

  it("keeps what is well-formed from a damaged value", () => {
    const raw = JSON.stringify({
      groups: [
        {
          activeId: "nope",
          tabs: [
            desc(),
            { kind: "bogus", prId: "a" },
            diff("x"),
            desc(),
            { kind: "diff", prId: "a" },
          ],
        },
        { tabs: [] },
      ],
      focusedGroup: 5,
      ratio: 7,
    });
    const layout = parseLayout(raw);
    expect(ids(layout)).toEqual(["description:a", "diff:a:x"]);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.activeId).toBe("description:a");
    expect(layout.focusedGroup).toBe(0);
    expect(layout.ratio).toBe(0.5);
  });

  it("keeps a tab stored in both groups only in the first, and puts static tabs in order", () => {
    const raw = JSON.stringify({
      groups: [
        { activeId: "comments:a", tabs: [diff("x"), comments(), desc()] },
        { activeId: "diff:a:x", tabs: [diff("x"), diff("y")] },
      ],
    });
    const layout = parseLayout(raw);
    expect(ids(layout, 0)).toEqual(["description:a", "comments:a", "diff:a:x"]);
    expect(ids(layout, 1)).toEqual(["diff:a:y"]);
    expect(layout.groups[1]?.activeId).toBe("diff:a:y");
    expect(layout.groups.map((g) => g.key)).toEqual(["a", "b"]);
  });

  it("starts empty on anything unreadable", () => {
    expect(parseLayout("{not json")).toEqual(emptyLayout());
    expect(parseLayout("[]")).toEqual(emptyLayout());
    expect(parseLayout(null)).toEqual(emptyLayout());
    expect(parseLayout(serializeLayout(emptyLayout()))).toEqual(emptyLayout());
  });
});

describe("adjacentPath", () => {
  const paths = ["a", "b", "c"];
  it("steps and wraps", () => {
    expect(adjacentPath(paths, "a", 1)).toBe("b");
    expect(adjacentPath(paths, "c", 1)).toBe("a");
    expect(adjacentPath(paths, "a", -1)).toBe("c");
  });
  it("starts at an end when nothing in the list is open", () => {
    expect(adjacentPath(paths, null, 1)).toBe("a");
    expect(adjacentPath(paths, "zzz", -1)).toBe("c");
    expect(adjacentPath([], null, 1)).toBeNull();
  });
});
