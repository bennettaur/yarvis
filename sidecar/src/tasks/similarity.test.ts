import { describe, expect, it } from "bun:test";
import { DUPLICATE_THRESHOLD, titleSimilarity, titleTokens } from "./similarity.ts";

describe("task title similarity", () => {
  it("drops stopwords and punctuation", () => {
    expect(titleTokens("Review the PR for events, and merge it!")).toEqual([
      "review",
      "pr",
      "events",
      "merge",
    ]);
  });

  it("scores a restatement of the same task as a duplicate", () => {
    expect(
      titleSimilarity("write the events consolidation job", "Write events consolidation job"),
    ).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
  });

  it("keeps a much larger task from matching a small one", () => {
    const score = titleSimilarity(
      "fix login",
      "fix the login redirect after a session expires on mobile",
    );
    expect(score).toBeLessThan(DUPLICATE_THRESHOLD);
  });

  it("scores unrelated titles near zero", () => {
    expect(titleSimilarity("review Sam's PR", "book the dentist")).toBe(0);
  });

  it("is unaffected by word order", () => {
    expect(titleSimilarity("merge main into my branches", "into my branches merge main")).toBe(1);
  });
});
