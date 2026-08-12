import { describe, expect, it } from "bun:test";
import { buildFileTree, type FileTreeDir, type FileTreeNode, flattenFileTree } from "./fileTree";
import type { PrFile } from "./pr/types";

const file = (filename: string): PrFile => ({
  filename,
  status: "modified",
  additions: 1,
  deletions: 0,
  patch: null,
});

const buildTree = (files: PrFile[]) => buildFileTree(files, (f) => f.filename);

const isDir = (n: FileTreeNode<PrFile>): n is FileTreeDir<PrFile> => n.type === "dir";

describe("buildFileTree", () => {
  it("keeps a top-level file at the root", () => {
    const tree = buildTree([file("README.md")]);
    expect(tree).toHaveLength(1);
    expect(tree[0]).toMatchObject({ type: "file", name: "README.md", path: "README.md" });
  });

  it("nests files under their directories", () => {
    const tree = buildTree([file("src/a.ts"), file("src/b.ts")]);
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["a.ts", "b.ts"]);
  });

  it("collapses a single-child folder chain into one node", () => {
    const tree = buildTree([file("src/components/pr/PrFileList.tsx")]);
    expect(tree).toHaveLength(1);
    const dir = tree[0];
    // The collapsed node keeps the deepest path, which is what keys its row.
    expect(dir).toMatchObject({
      type: "dir",
      name: "src/components/pr",
      path: "src/components/pr",
    });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children[0]).toMatchObject({ name: "PrFileList.tsx" });
  });

  it("stops collapsing where a folder holds a file beside a subdirectory", () => {
    const tree = buildTree([file("src/index.ts"), file("src/pr/one.ts")]);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["pr", "index.ts"]);
  });

  it("stops collapsing where a folder branches", () => {
    const tree = buildTree([file("src/a/one.ts"), file("src/b/two.ts")]);
    const dir = tree[0];
    expect(dir).toMatchObject({ type: "dir", name: "src" });
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["a", "b"]);
  });

  it("orders directories before files", () => {
    const tree = buildTree([file("a.ts"), file("dir/b.ts")]);
    expect(tree.map((n) => n.type)).toEqual(["dir", "file"]);
  });

  it("sorts same-type siblings alphabetically regardless of input order", () => {
    const tree = buildTree([file("src/z.ts"), file("src/a.ts")]);
    const dir = tree[0];
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children.map((c) => c.name)).toEqual(["a.ts", "z.ts"]);
  });

  it("sorts sibling directories alphabetically regardless of input order", () => {
    const tree = buildTree([file("zeta/one.ts"), file("alpha/two.ts")]);
    expect(tree.map((n) => n.name)).toEqual(["alpha", "zeta"]);
  });

  it("keeps each leaf's full path alongside its basename", () => {
    const tree = buildTree([file("src/components/pr/deep.ts")]);
    const dir = tree[0];
    if (!isDir(dir)) throw new Error("expected dir");
    expect(dir.children[0]).toMatchObject({
      name: "deep.ts",
      path: "src/components/pr/deep.ts",
    });
  });

  // Bare path strings are what the workspace views hand in.
  it("builds a tree from plain path strings", () => {
    const tree = buildFileTree(["src/b.ts", "src/a.ts"], (path) => path);
    const dir = tree[0];
    if (dir?.type !== "dir") throw new Error("expected dir");
    expect(flattenFileTree(dir.children).map((n) => n.file)).toEqual(["src/a.ts", "src/b.ts"]);
  });
});

describe("flattenFileTree", () => {
  it("reads files back in the order their rows appear", () => {
    const tree = buildTree([
      file("z.ts"),
      file("src/b.ts"),
      file("a.ts"),
      file("src/a.ts"),
      file("docs/readme.md"),
    ]);
    expect(flattenFileTree(tree).map((n) => n.file.filename)).toEqual([
      "docs/readme.md",
      "src/a.ts",
      "src/b.ts",
      "a.ts",
      "z.ts",
    ]);
  });

  // Collapsing rebuilds the folder nodes around a file, so a collapsed chain is
  // where a file could go missing from the flattened order.
  it("reaches a file inside a collapsed folder chain", () => {
    const tree = buildTree([file("z.ts"), file("src/components/pr/deep.ts")]);
    expect(flattenFileTree(tree).map((n) => n.file.filename)).toEqual([
      "src/components/pr/deep.ts",
      "z.ts",
    ]);
  });

  it("returns nothing for an empty tree", () => {
    expect(flattenFileTree([])).toEqual([]);
  });
});
