import { describe, expect, it } from "bun:test";
import { isUserGivenUrl, urlsIn } from "./provenance.ts";

describe("urlsIn", () => {
  it("finds URLs in prose and Markdown, without the punctuation around them", () => {
    const urls = urlsIn([
      "Read https://example.com/post. Also (see https://a.test/x), and [this](https://b.test/y).",
    ]);
    expect([...urls].sort()).toEqual([
      "https://a.test/x",
      "https://b.test/y",
      "https://example.com/post",
    ]);
  });

  it("keeps a closing bracket the URL opened itself", () => {
    const urls = urlsIn(["https://en.wikipedia.org/wiki/Fish_(food)."]);
    expect([...urls]).toEqual(["https://en.wikipedia.org/wiki/Fish_(food)"]);
  });
});

describe("isUserGivenUrl", () => {
  const given = urlsIn(["summarize https://example.com/a?id=1#intro"]);

  it("matches the same URL, ignoring the fragment and trivial normalization", () => {
    expect(isUserGivenUrl("https://example.com/a?id=1", given)).toBe(true);
    expect(isUserGivenUrl("HTTPS://EXAMPLE.COM/a?id=1#other", given)).toBe(true);
  });

  it("does not match a URL with anything added to its path or query", () => {
    // The exfiltration shape: the user's link with data appended.
    expect(isUserGivenUrl("https://example.com/a?id=1&q=memories", given)).toBe(false);
    expect(isUserGivenUrl("https://example.com/a/secret?id=1", given)).toBe(false);
    expect(isUserGivenUrl("https://evil.test/?u=https://example.com/a?id=1", given)).toBe(false);
  });

  it("does not match something that isn't a URL", () => {
    expect(isUserGivenUrl("not a url", given)).toBe(false);
  });
});
