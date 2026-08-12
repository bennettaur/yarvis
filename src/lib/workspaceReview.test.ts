import { describe, expect, it } from "bun:test";
import { formatLineRange, formatReviewComments, type ReviewComment } from "./workspaceReview";

const comment = (over: Partial<ReviewComment> = {}): ReviewComment => ({
  id: "c-1",
  workspaceRepoId: "wr-1",
  path: "src/a.ts",
  startLine: 12,
  endLine: 12,
  commitSha: "abc1234def5678",
  body: "Rename this.",
  resolvedAt: null,
  createdAt: "2026-06-01T09:00:00.000Z",
  updatedAt: "2026-06-01T09:00:00.000Z",
  ...over,
});

const noRepoNames = () => null;

describe("formatLineRange", () => {
  it("renders a single line as one number", () => {
    expect(formatLineRange({ startLine: 12, endLine: 12 })).toBe("12");
  });

  it("renders a span as a range", () => {
    expect(formatLineRange({ startLine: 12, endLine: 18 })).toBe("12-18");
  });
});

describe("formatReviewComments", () => {
  it("numbers each comment under its file, lines, and abbreviated commit", () => {
    const text = formatReviewComments([comment()], noRepoNames);
    expect(text).toContain("1 review comment");
    expect(text).toContain("1. src/a.ts:12 (at abc1234)");
    expect(text).toContain("   Rename this.");
  });

  it("leaves resolved comments out", () => {
    const text = formatReviewComments(
      [
        comment(),
        comment({ id: "c-2", body: "Done with this one.", resolvedAt: "2026-06-01T10:00:00.000Z" }),
      ],
      noRepoNames,
    );
    expect(text).toContain("1 review comment");
    expect(text).not.toContain("Done with this one.");
  });

  it("is empty when nothing is open, so there is nothing to paste", () => {
    expect(
      formatReviewComments([comment({ resolvedAt: "2026-06-01T10:00:00.000Z" })], noRepoNames),
    ).toBe("");
  });

  it("prefixes the repo when the caller names one", () => {
    const text = formatReviewComments([comment()], () => "web");
    expect(text).toContain("1. web/src/a.ts:12");
  });

  it("indents every line of a multi-line body under its entry", () => {
    const text = formatReviewComments([comment({ body: "First.\nSecond." })], noRepoNames);
    expect(text).toContain("   First.\n   Second.");
  });

  it("omits the commit when the branch had none", () => {
    const text = formatReviewComments([comment({ commitSha: null })], noRepoNames);
    expect(text).toContain("1. src/a.ts:12\n");
    expect(text).not.toContain("(at ");
  });
});
