import type { PrFile } from "../../lib/pr/types";

/** A changed file, sitting at a leaf of the tree. */
export interface FileTreeFile {
  type: "file";
  /** Basename shown in the row; the full path lives on `file.filename`. */
  name: string;
  file: PrFile;
}

/** A directory grouping child files and subdirectories. */
export interface FileTreeDir {
  type: "dir";
  /** Segment label; chained single-child folders join as `a/b/c`. */
  name: string;
  /** Full slash path from the root, unique per node — used as a stable key. */
  path: string;
  children: FileTreeNode[];
}

export type FileTreeNode = FileTreeFile | FileTreeDir;

function sortChildren(children: FileTreeNode[]): void {
  children.sort((a, b) => {
    // Directories before files, then alphabetical within each group.
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  for (const child of children) {
    if (child.type === "dir") sortChildren(child.children);
  }
}

/**
 * Fold a directory that holds only a single subdirectory into its child, so a
 * deep `src/components/pr` chain reads on one row instead of three empty levels
 * — matching how GitHub renders its file tree.
 */
function collapseChain(node: FileTreeNode): FileTreeNode {
  if (node.type === "file") return node;
  let dir = node;
  while (dir.children.length === 1 && dir.children[0].type === "dir") {
    const only = dir.children[0];
    dir = {
      type: "dir",
      name: `${dir.name}/${only.name}`,
      path: only.path,
      children: only.children,
    };
  }
  return { ...dir, children: dir.children.map(collapseChain) };
}

/**
 * Turn a flat list of changed files into a folder tree. Roots come back sorted
 * (folders first) with single-child folder chains collapsed for a compact
 * display.
 */
export function buildFileTree(files: PrFile[]): FileTreeNode[] {
  const root: FileTreeDir = { type: "dir", name: "", path: "", children: [] };
  for (const file of files) {
    const parts = file.filename.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const path = dir.path ? `${dir.path}/${seg}` : seg;
      let child = dir.children.find((c): c is FileTreeDir => c.type === "dir" && c.path === path);
      if (!child) {
        child = { type: "dir", name: seg, path, children: [] };
        dir.children.push(child);
      }
      dir = child;
    }
    dir.children.push({ type: "file", name: parts[parts.length - 1], file });
  }
  sortChildren(root.children);
  return root.children.map(collapseChain);
}

/** Read the files back out of a tree in the order the rows appear top to bottom. */
export function flattenFileTree(nodes: FileTreeNode[]): FileTreeFile[] {
  const files: FileTreeFile[] = [];
  const walk = (node: FileTreeNode) => {
    if (node.type === "file") files.push(node);
    else node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return files;
}
