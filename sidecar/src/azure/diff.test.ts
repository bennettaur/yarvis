import { describe, expect, it } from "bun:test";
import { buildPatch } from "./diff.ts";

describe("azure diff builder", () => {
  it("returns null patch when content is unchanged", () => {
    expect(buildPatch("f.txt", "same\n", "same\n")).toEqual({
      patch: null,
      additions: 0,
      deletions: 0,
    });
  });

  it("builds a patch that starts at the first hunk header", () => {
    const { patch } = buildPatch("f.txt", "a\nb\nc\n", "a\nB\nc\n");
    expect(patch).not.toBeNull();
    expect(patch!.startsWith("@@")).toBe(true);
    expect(patch).not.toContain("Index:");
    expect(patch).not.toContain("+++");
  });

  it("counts a single-line modification as one addition and one deletion", () => {
    const { additions, deletions } = buildPatch("f.txt", "a\nb\nc\n", "a\nB\nc\n");
    expect(additions).toBe(1);
    expect(deletions).toBe(1);
  });

  it("treats an empty base as an added file (all additions)", () => {
    const { additions, deletions } = buildPatch("new.txt", "", "x\ny\n");
    expect(additions).toBe(2);
    expect(deletions).toBe(0);
  });

  it("treats an empty head as a removed file (all deletions)", () => {
    const { additions, deletions } = buildPatch("gone.txt", "x\ny\n", "");
    expect(additions).toBe(0);
    expect(deletions).toBe(2);
  });
});
