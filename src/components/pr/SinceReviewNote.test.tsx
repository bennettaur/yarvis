import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrDetail, PrRef } from "../../lib/pr/types";
import { primeCache } from "../../lib/resourceCache";
import { reviewMarkPrefix } from "../../lib/reviewWorkspaces/sinceReview";
import { renderToHtml, textOf } from "../../test/render";
import SinceReviewNote, { sinceReviewNoteText } from "./SinceReviewNote";

const ref: PrRef = { provider: "github", owner: "acme", repo: "widgets", number: 7 };
const sha = (c: string) => c.repeat(40);
const mark = {
  headSha: sha("a"),
  baseSha: null,
  mergeBaseSha: null,
  source: "review" as const,
  createdAt: "2026-10-01T00:00:00Z",
};

describe("sinceReviewNoteText", () => {
  it("counts new commits, and says nothing when there are none or no review", () => {
    const since = (commits: number | null, rewritten = false, exists = true) => ({
      mark,
      headSha: sha("b"),
      since: { commits, rewritten, exists },
    });
    expect(sinceReviewNoteText(since(3))).toBe("3 new commits since your review.");
    expect(sinceReviewNoteText(since(1))).toBe("1 new commit since your review.");
    expect(sinceReviewNoteText(since(0))).toBeNull();
    expect(sinceReviewNoteText(since(5, true))).toBe("Force-pushed since your last review.");
    expect(sinceReviewNoteText(since(null, true, false))).toContain("is gone");
    expect(sinceReviewNoteText({ mark: null, headSha: null, since: null })).toBeNull();
  });
});

describe("SinceReviewNote", () => {
  it("links a PR that moved on since the review to the review workspace", async () => {
    primeCache(`${reviewMarkPrefix(ref)}provider:${sha("b")}`, {
      mark: { ...mark, source: "provider" },
      headSha: sha("b"),
      since: { commits: 2, rewritten: false, exists: true },
    });
    const html = await renderToHtml(
      createElement(SinceReviewNote, {
        prRef: ref,
        title: "Teach the parser tabs",
        detail: { headSha: sha("b") } as PrDetail,
      }),
    );
    expect(textOf(html)).toContain("2 new commits since your review.");
    expect(textOf(html)).toContain("your last review was on GitHub");
    expect(textOf(html)).toContain("See what changed in a review workspace");
  });
});
