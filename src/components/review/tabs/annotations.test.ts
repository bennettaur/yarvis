import { describe, expect, it } from "bun:test";
import type { PrInsight } from "../../../lib/pr/insights";
import { reviewThread } from "../../../test/reviewThread";
import {
  commentAnchors,
  commentCountsByPath,
  insightLines,
  linesText,
  openThreadsByPath,
  splitThreads,
} from "./annotations";

const insight = (endLine: number, path = "a.ts"): PrInsight => ({
  id: `i${endLine}`,
  path,
  startLine: endLine,
  endLine,
  headSha: "h",
  question: "why?",
  answer: "because",
  postedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
});

describe("splitThreads", () => {
  it("keeps the file's placeable threads inline and lists the rest as outdated", () => {
    const placed = reviewThread({ id: "A", path: "a.ts", line: 4 });
    const outdated = reviewThread({ id: "B", path: "a.ts", line: 9, isOutdated: true });
    const lineless = reviewThread({ id: "C", path: "a.ts", line: null });
    const other = reviewThread({ id: "D", path: "b.ts", line: 1 });
    const { inline, outdated: listed } = splitThreads([placed, outdated, lineless, other], "a.ts");
    expect(inline.map((t) => t.id)).toEqual(["A"]);
    expect(listed.map((t) => t.id)).toEqual(["B", "C"]);
  });
});

describe("commentAnchors", () => {
  it("gives each side and line one anchor, top to bottom, left before right", () => {
    const threads = [
      reviewThread({ id: "A", line: 10, side: "RIGHT" }),
      reviewThread({ id: "B", line: 10, side: "RIGHT" }),
      reviewThread({ id: "C", line: 10, side: "LEFT" }),
      reviewThread({ id: "D", line: 2, side: "RIGHT", startLine: 1 }),
    ];
    expect(commentAnchors(threads, [], null)).toEqual([
      { side: "RIGHT", line: 2 },
      { side: "LEFT", line: 10 },
      { side: "RIGHT", line: 10 },
    ]);
  });

  it("adds a line for an unechoed comment and for the open composer", () => {
    const anchors = commentAnchors([reviewThread({ line: 5 })], [{ side: "LEFT", line: 3 }], {
      side: "RIGHT",
      line: 5,
    });
    expect(anchors).toEqual([
      { side: "LEFT", line: 3 },
      { side: "RIGHT", line: 5 },
    ]);
  });
});

describe("insightLines", () => {
  it("hangs answers under their last line, plus the open question", () => {
    expect(insightLines([insight(8), insight(3), insight(8)], { endLine: 5 })).toEqual([3, 5, 8]);
    expect(insightLines(undefined, null)).toEqual([]);
  });
});

describe("linesText", () => {
  it("reads an inclusive, one-based range", () => {
    expect(linesText("a\nb\nc\nd", 2, 3)).toBe("b\nc");
    expect(linesText("a\nb", 1, 1)).toBe("a");
  });
});

describe("tree counts", () => {
  it("counts every comment on a file and flags files with open threads", () => {
    const threads = [
      reviewThread({ id: "A", path: "a.ts", bodies: ["x", "y"] }),
      reviewThread({ id: "B", path: "a.ts", isResolved: true, isOutdated: true, line: null }),
      reviewThread({ id: "C", path: "b.ts", isResolved: true }),
      reviewThread({ id: "D", path: null }),
    ];
    expect(commentCountsByPath(threads)).toEqual(
      new Map([
        ["a.ts", 3],
        ["b.ts", 1],
      ]),
    );
    expect(openThreadsByPath(threads)).toEqual(new Set(["a.ts"]));
  });
});
