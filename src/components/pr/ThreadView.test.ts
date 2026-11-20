import { describe, expect, it } from "bun:test";
import { describeLines, needsLineLabel } from "./ThreadView";

describe("describeLines", () => {
  it("names a single new-file line plainly", () => {
    expect(describeLines({ line: 4, side: "RIGHT" })).toBe("line 4");
  });

  it("marks a range in the old file", () => {
    expect(describeLines({ line: 9, startLine: 4, side: "LEFT" })).toBe("lines 4–9 (old)");
  });

  // The two numbers count lines in different files, so "lines 12–3" would be
  // nonsense; each end names its own file.
  it("names both files for a range that crosses from old to new", () => {
    expect(describeLines({ line: 3, startLine: 12, side: "RIGHT", startSide: "LEFT" })).toBe(
      "old line 12 to new line 3",
    );
  });
});

describe("needsLineLabel", () => {
  it("skips a plain new-file comment and labels the rest", () => {
    expect(needsLineLabel({ side: "RIGHT" })).toBe(false);
    expect(needsLineLabel({ side: "LEFT" })).toBe(true);
    expect(needsLineLabel({ side: "RIGHT", startLine: 2 })).toBe(true);
  });
});
