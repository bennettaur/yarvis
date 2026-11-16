/**
 * The contract of `addExtraWorktree` (in `service.ts`), kept apart from the
 * service so the MCP tool that calls it doesn't import the whole service.
 */

/** A request to add a worktree that the caller can fix; its message is safe to show them. */
export class WorktreeRefusal extends Error {}

export interface AddExtraWorktreeInput {
  /** The repo's folder in the workspace, or its name. */
  repo: string;
  /** The branch to check out. It must not be in the clone yet. */
  branch: string;
  /**
   * The remote branch a new branch starts from. Without it, `branch` is checked
   * out from the remote when it is there, and otherwise cut from the
   * workspace's base branch.
   */
  base?: string;
}

export interface AddExtraWorktreeResult {
  /** The new worktree's folder. */
  path: string;
  branch: string;
  /** The remote branch it was checked out from or cut from, as `origin/<name>`. */
  startedFrom: string;
}

/**
 * Extra worktrees one workspace repo can have at a time. Each is a full
 * checkout, and adding one fetches under the repo lock other workspaces share.
 */
export const MAX_EXTRA_WORKTREES = 10;

/**
 * Whether git or the workspaces sharing the clone read `branch` as something
 * other than a branch, whatever its case. `origin/main` as a local branch
 * would shadow the remote-tracking ref of the same short name.
 */
export function isReservedBranchName(branch: string): boolean {
  const name = branch.toLowerCase();
  return RESERVED_FIRST_SEGMENTS.has(name.split("/")[0]!) || name.endsWith("_head");
}

const RESERVED_FIRST_SEGMENTS = new Set(["origin", "refs", "heads", "remotes", "tags", "head"]);

/**
 * The existing branch `branch` would collide with, or null. Compared without
 * case, because the clone usually sits on a case-insensitive filesystem, where
 * `MAIN` and `main` are the same ref file. A branch can't nest under another
 * either (`stack` and `stack/two`), since one ref's file would be the other's
 * folder.
 */
export function branchCollision(branch: string, existing: Iterable<string>): string | null {
  const wanted = branch.toLowerCase();
  for (const name of existing) {
    const other = name.toLowerCase();
    if (other === wanted || other.startsWith(`${wanted}/`) || wanted.startsWith(`${other}/`)) {
      return name;
    }
  }
  return null;
}
