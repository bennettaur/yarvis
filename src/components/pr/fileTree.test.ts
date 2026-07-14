import { describe, expect, it } from "bun:test";
import type { PrFile } from "../../lib/pr/types";
import { buildFileTree, type FileTreeDir, type FileTreeNode } from "./fileTree";

const file = (filename: string): PrFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: null,
});

const isDir = (n: FileTreeNode): n is FileTreeDir => n.type === "dir";

describe("buildFileTree", () => {
  it("keeps a top-level file at the root", () => {
    const tree = buildFileTree([file("README.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ type: "file", name: "README.md", index: 0 });
  });

  it("nests files under their directories", () => {
    const tree = buildFileTree([file("src/a.ts"), file("src/b.ts")]);
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("preserves the original index for the diff anchor", () => {
    const tree = buildFileTree([file("z.ts"), file("src/a.ts")]);
    // Sorted dirs-first, so src comes before the root file.
    const dir = tree[0];
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children[0]).toMatchObject({ name: "a.ts", index: 1 });
    expect(tree[1]).toMatchObject({ name: "z.ts", index: 0 });
  });

  it("collapses a single-child folder chain into one node", () => {
    const tree = buildFileTree([file("src/components/pr/PrFileList.tsx")]);
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src/components/pr" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children[0]).toMatchObject({ name: "PrFileList.tsx" });
  });

  it("stops collapsing where a folder branches", () => {
    const tree = buildFileTree([file("src/a/one.ts"), file("src/b/two.ts")]);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("orders directories before files", () => {
    const tree = buildFileTree([file("a.ts"), file("dir/b.ts")]);
    expect(tree.map((n) => n.type)).toEqual(["dir", "file"]);
  });
});
