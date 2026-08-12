/** A file, sitting at a leaf of the tree. */
export interface FileTreeFile<T> {
  type: "file";
  /** Basename shown in the row. */
  name: string;
  /** Full slash path from the root, unique per node — used as a stable key. */
  path: string;
  /** The caller's own item for this path (a PR file, a changed file, a path). */
  file: T;
}

/** A directory grouping child files and subdirectories. */
export interface FileTreeDir<T> {
  type: "dir";
  /** Segment label; chained single-child folders join as `a/b/c`. */
  name: string;
  /** Full slash path from the root, unique per node — used as a stable key. */
  path: string;
  children: FileTreeNode<T>[];
}

export type FileTreeNode<T> = FileTreeFile<T> | FileTreeDir<T>;

function sortChildren<T>(children: FileTreeNode<T>[]): void {
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
function collapseChain<T>(node: FileTreeNode<T>): FileTreeNode<T> {
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
 * Turn a flat list of files into a folder tree. Roots come back sorted (folders
 * first) with single-child folder chains collapsed for a compact display.
 * `getPath` reads the slash path off each item, so the same tree serves PR
 * files, worktree changes, and bare path strings.
 */
export function buildFileTree<T>(files: T[], getPath: (file: T) => string): FileTreeNode<T>[] {
  const root: FileTreeDir<T> = { type: "dir", name: "", path: "", children: [] };
  // Directories by full path, so finding a parent stays O(1) — a workspace's
  // "all files" list is the whole worktree, where scanning a folder's children
  // once per path segment is quadratic.
  const dirs = new Map<string, FileTreeDir<T>>([["", root]]);
  for (const file of files) {
    const filePath = getPath(file);
    const parts = filePath.split("/");
    let dir = root;
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      const path = dir.path ? `${dir.path}/${seg}` : seg;
      let child = dirs.get(path);
      if (!child) {
        child = { type: "dir", name: seg, path, children: [] };
        dir.children.push(child);
        dirs.set(path, child);
      }
      dir = child;
    }
    dir.children.push({ type: "file", name: parts[parts.length - 1], path: filePath, file });
  }
  sortChildren(root.children);
  return root.children.map(collapseChain);
}

/** Read the files back out of a tree in the order the rows appear top to bottom. */
export function flattenFileTree<T>(nodes: FileTreeNode<T>[]): FileTreeFile<T>[] {
  const files: FileTreeFile<T>[] = [];
  const walk = (node: FileTreeNode<T>) => {
    if (node.type === "file") files.push(node);
    else node.children.forEach(walk);
  };
  nodes.forEach(walk);
  return files;
}
