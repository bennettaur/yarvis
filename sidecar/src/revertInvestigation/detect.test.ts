import { describe, expect, it } from "bun:test";
import { revertedPrNumber, revertedShaOf } from "./detect.ts";

describe("revertedShaOf", () => {
  it("reads the sha from a revert commit message", () => {
    expect(revertedShaOf('Revert "Add x"\n\nThis reverts commit 0123abcdef0123abcdef.')).toBe(
      "0123abcdef0123abcdef",
    );
  });

  it("is null for an ordinary commit", () => {
    expect(revertedShaOf("Fix the widget")).toBeNull();
  });
});

describe("revertedPrNumber", () => {
  const title = 'Revert "Add x"';

  it("reads GitHub's own revert body", () => {
    expect(revertedPrNumber({ title, body: "Reverts acme/widget#12" }, "acme", "widget")).toBe(12);
  });

  it("reads a bare reference", () => {
    expect(revertedPrNumber({ title, body: "Backing out #34 for now" }, "acme", "widget")).toBe(34);
  });

  it("ignores a reference into another repo", () => {
    expect(revertedPrNumber({ title, body: "Reverts other/repo#12" }, "acme", "widget")).toBeNull();
  });

  it("ignores a PR that isn't titled Revert", () => {
    expect(revertedPrNumber({ title: "Add x", body: "Reverts #12" }, "acme", "widget")).toBeNull();
  });
});
