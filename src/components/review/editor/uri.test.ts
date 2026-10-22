import { describe, expect, it } from "bun:test";
import { parseReviewUri, reviewUri } from "./uri";

describe("reviewUri", () => {
  it("names a file at one side of one PR", () => {
    expect(reviewUri("gh-acme-web-7", "head", "src/app.ts")).toBe(
      "review://gh-acme-web-7/head/src/app.ts",
    );
  });

  it("encodes each segment so odd file names survive a round trip", () => {
    const uri = reviewUri("gh-acme-web-7", "base", "docs/a b#1?.md");
    expect(uri).toBe("review://gh-acme-web-7/base/docs/a%20b%231%3F.md");
    expect(parseReviewUri(uri)).toEqual({
      refDomKey: "gh-acme-web-7",
      side: "base",
      path: "docs/a b#1?.md",
    });
  });

  it("ignores leading and doubled slashes in the path", () => {
    expect(reviewUri("k", "head", "/a//b.ts")).toBe("review://k/head/a/b.ts");
  });
});

describe("parseReviewUri", () => {
  it("rejects URIs that are not review files", () => {
    expect(parseReviewUri("file:///tmp/a.ts")).toBeNull();
    expect(parseReviewUri("review://k/middle/a.ts")).toBeNull();
    expect(parseReviewUri("review://k/head/")).toBeNull();
    expect(parseReviewUri("review://k/head/%E0%A4%A")).toBeNull();
  });
});
