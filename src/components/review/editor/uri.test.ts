import { describe, expect, it } from "bun:test";
// @ts-expect-error Monaco ships no types for its internal modules; this is the
// parser its `Uri` uses, loaded alone because the editor itself needs a browser.
import { URI } from "monaco-editor/base/common/uri.js";
import { uriKey } from "./navigation";
import { parseReviewUri, reviewUri } from "./uri";

const parseLikeMonaco = (uri: string) =>
  URI.parse(uri) as { scheme: string; authority: string; path: string; toString(): string };

describe("reviewUri", () => {
  it("names a file at one side of one PR and parses back", () => {
    const uri = reviewUri("gh:acme/web/7", "head", "src/app.ts");
    expect(uri.startsWith("review://")).toBe(true);
    expect(uri.endsWith("/head/src/app.ts")).toBe(true);
    expect(parseReviewUri(uri)).toEqual({
      refKey: "gh:acme/web/7",
      side: "head",
      path: "src/app.ts",
    });
  });

  it("keeps PRs apart whose keys differ only where refDomKey would fold them", () => {
    const a = reviewUri("gh:acme/web-app/7", "head", "a.ts");
    const b = reviewUri("gh:acme-web/app/7", "head", "a.ts");
    expect(a).not.toBe(b);
    expect(parseReviewUri(a)?.refKey).toBe("gh:acme/web-app/7");
    expect(parseReviewUri(b)?.refKey).toBe("gh:acme-web/app/7");
  });

  it("keeps PRs apart whose keys differ only in case", () => {
    expect(reviewUri("gh:Acme/web/7", "head", "a.ts")).not.toBe(
      reviewUri("gh:acme/web/7", "head", "a.ts"),
    );
  });

  it("encodes each segment so odd file names survive a round trip", () => {
    const uri = reviewUri("az:org/Proj X/web/42", "base", "docs/a b#1?.md");
    expect(uri.endsWith("/base/docs/a%20b%231%3F.md")).toBe(true);
    expect(parseReviewUri(uri)).toEqual({
      refKey: "az:org/Proj X/web/42",
      side: "base",
      path: "docs/a b#1?.md",
    });
  });

  it("ignores leading and doubled slashes in the path", () => {
    expect(reviewUri("k", "head", "/a//b.ts")).toBe(reviewUri("k", "head", "a/b.ts"));
  });
});

describe("parseReviewUri", () => {
  it("rejects URIs that are not review files", () => {
    const authority = reviewUri("k", "head", "a.ts").split("/")[2];
    expect(parseReviewUri("file:///tmp/a.ts")).toBeNull();
    expect(parseReviewUri(`review://${authority}/middle/a.ts`)).toBeNull();
    expect(parseReviewUri(`review://${authority}/head/`)).toBeNull();
    expect(parseReviewUri(`review://${authority}/head/%E0%A4%A`)).toBeNull();
    // An authority that isn't hex we wrote.
    expect(parseReviewUri("review://gh-acme-web-7/head/a.ts")).toBeNull();
    expect(parseReviewUri("review://abc/head/a.ts")).toBeNull();
  });
});

describe("uriKey", () => {
  it("rebuilds the same review URI after Monaco has parsed it", () => {
    for (const path of ["src/a b.ts", "odd/#hash.ts", "q?x=1.ts", "100%.ts", "ünï/çødé.ts"]) {
      const uri = reviewUri("gh:acme/web/7", "head", path);
      expect(uriKey(parseLikeMonaco(uri))).toBe(uri);
      // And after Monaco has printed and re-read it, as a model's URI is.
      expect(uriKey(parseLikeMonaco(parseLikeMonaco(uri).toString()))).toBe(uri);
    }
  });

  it("leaves other URIs as Monaco prints them", () => {
    expect(uriKey(parseLikeMonaco("https://example.com/a"))).toBe("https://example.com/a");
  });
});
