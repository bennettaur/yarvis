import { describe, expect, it } from "bun:test";
import { resolvePrLocator } from "./locate";
import type { PrRef } from "./types";

const REPOS = [
  { owner: "acme", repo: "widgets" },
  { owner: "personal", repo: "widgets" },
  { owner: "acme", repo: "gadgets" },
];

describe("resolvePrLocator", () => {
  it("reads a PR link, ignoring trailing path, query and hash", () => {
    for (const input of [
      "https://github.com/acme/widgets/pull/42",
      "https://github.com/acme/widgets/pull/42/files",
      "https://github.com/acme/widgets/pull/42#discussion_r1",
      "https://github.com/acme/widgets/pull/42?w=1",
      "github.com/acme/widgets/pull/42",
    ]) {
      expect(resolvePrLocator(input)).toEqual([
        { provider: "github", owner: "acme", repo: "widgets", number: 42 },
      ]);
    }
  });

  it("reads the owner-qualified shorthands", () => {
    const expected: PrRef[] = [{ provider: "github", owner: "acme", repo: "widgets", number: 42 }];
    expect(resolvePrLocator("acme/widgets#42")).toEqual(expected);
    expect(resolvePrLocator("acme/widgets 42")).toEqual(expected);
    expect(resolvePrLocator("acme/widgets #42")).toEqual(expected);
    expect(resolvePrLocator("acme/widgets/42")).toEqual(expected);
    expect(resolvePrLocator("  acme/widgets#42  ")).toEqual(expected);
  });

  it("resolves a bare repo name against the registered repos", () => {
    expect(resolvePrLocator("gadgets#7", REPOS)).toEqual([
      { provider: "github", owner: "acme", repo: "gadgets", number: 7 },
    ]);
  });

  it("returns every owner when a bare repo name is ambiguous", () => {
    expect(resolvePrLocator("widgets#7", REPOS)).toEqual([
      { provider: "github", owner: "acme", repo: "widgets", number: 7 },
      { provider: "github", owner: "personal", repo: "widgets", number: 7 },
    ]);
  });

  it("matches a bare repo name case-insensitively", () => {
    expect(resolvePrLocator("GADGETS#7", REPOS)).toEqual([
      { provider: "github", owner: "acme", repo: "gadgets", number: 7 },
    ]);
  });

  it("rejects input with no repo to attach a number to", () => {
    expect(resolvePrLocator("")).toEqual([]);
    expect(resolvePrLocator("42")).toEqual([]);
    expect(resolvePrLocator("#42")).toEqual([]);
    // An unregistered repo name has no owner to resolve to.
    expect(resolvePrLocator("unknown#42", REPOS)).toEqual([]);
  });

  it("rejects links that aren't GitHub PRs", () => {
    expect(resolvePrLocator("https://github.com/acme/widgets/issues/42")).toEqual([]);
    expect(resolvePrLocator("https://example.com/acme/widgets/pull/42")).toEqual([]);
    expect(resolvePrLocator("https://dev.azure.com/org/proj/_git/widgets/pullrequest/42")).toEqual(
      [],
    );
  });
});
