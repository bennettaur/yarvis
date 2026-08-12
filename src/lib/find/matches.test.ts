import { describe, expect, it } from "bun:test";
import { matchRanges } from "./matches";

describe("matchRanges", () => {
  it("finds every occurrence in document order", () => {
    expect(matchRanges("beta alpha beta", "beta")).toEqual([
      { start: 0, end: 4 },
      { start: 11, end: 15 },
    ]);
  });

  it("ignores case by default", () => {
    expect(matchRanges("Alpha ALPHA alpha", "alpha")).toEqual([
      { start: 0, end: 5 },
      { start: 6, end: 11 },
      { start: 12, end: 17 },
    ]);
  });

  it("respects case when asked to", () => {
    expect(matchRanges("Alpha alpha", "alpha", true)).toEqual([{ start: 6, end: 11 }]);
  });

  // Overlapping hits would highlight the same characters twice and inflate the
  // count, so the search resumes after each match.
  it("does not return overlapping matches", () => {
    expect(matchRanges("aaaa", "aa")).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it("has nothing to match on an empty query", () => {
    expect(matchRanges("alpha", "")).toEqual([]);
  });

  // Case folding must not change the string's length: an offset returned here
  // is used directly against the original text to build a DOM range.
  it("keeps offsets aligned across characters that grow when lowercased", () => {
    const text = "İstanbul beta";
    const [match] = matchRanges(text, "beta");
    expect(text.slice(match.start, match.end)).toBe("beta");
  });

  it("matches across accented characters", () => {
    expect(matchRanges("Café", "café")).toEqual([{ start: 0, end: 4 }]);
  });
});
