import { describe, expect, it } from "bun:test";
import { reviewUri } from "../editor";
import { tabForLocation } from "./location";

const targets = {
  prId: "pr-1",
  refKey: "gh:o/r/1",
  tree: new Set(["src/a.ts", "src/b.ts", "docs/readme.md"]),
  changed: new Set(["src/a.ts", "src/gone.ts"]),
};
const range = { startLineNumber: 12, startColumn: 3, endLineNumber: 12, endColumn: 9 };
const uri = (path: string, refKey = "gh:o/r/1", side: "base" | "head" = "head") =>
  reviewUri(refKey, side, path);

describe("tabForLocation", () => {
  it("opens the diff for a file the PR changes, at the landing line", () => {
    expect(tabForLocation(uri("src/a.ts"), range, targets)).toEqual({
      kind: "diff",
      prId: "pr-1",
      path: "src/a.ts",
      revealLine: 12,
    });
    // A deleted file is only in the change list.
    expect(tabForLocation(uri("src/gone.ts", "gh:o/r/1", "base"), range, targets)).toMatchObject({
      kind: "diff",
      path: "src/gone.ts",
    });
  });

  it("opens the plain file for one it doesn't, and leaves the line alone without a range", () => {
    expect(tabForLocation(uri("src/b.ts"), null, targets)).toEqual({
      kind: "file",
      prId: "pr-1",
      path: "src/b.ts",
    });
  });

  it("refuses anything that isn't a file this PR has", () => {
    expect(tabForLocation("file:///etc/passwd", range, targets)).toBeNull();
    expect(tabForLocation("https://example.com/x", range, targets)).toBeNull();
    expect(tabForLocation(uri("src/nowhere.ts"), range, targets)).toBeNull();
    expect(tabForLocation("review://zz/head/src/a.ts", range, targets)).toBeNull();
  });

  it("refuses a landing in another PR's model", () => {
    expect(tabForLocation(uri("src/b.ts", "gh:o/r/2"), range, targets)).toBeNull();
  });

  it("opens the file an alias stand-in re-exports, at its top", () => {
    const shims = new Map([["node_modules/@/b.ts", "src/b.ts"]]);
    expect(tabForLocation(uri("node_modules/@/b.ts"), range, targets, shims)).toEqual({
      kind: "file",
      prId: "pr-1",
      path: "src/b.ts",
    });
    // Without the map, a stand-in is no file of the PR's.
    expect(tabForLocation(uri("node_modules/@/b.ts"), range, targets)).toBeNull();
  });
});
