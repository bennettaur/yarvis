/**
 * Deleting a workspace's own folder once its worktrees are gone, so an archive
 * leaves nothing behind in the workspaces root.
 */

import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";

/**
 * What Yarvis writes at a workspace root, plus Finder's `.DS_Store`. A folder
 * holding only these has nothing of the user's left in it.
 */
const YARVIS_ROOT_ENTRIES = new Set([
  ".claude",
  ".mcp.json",
  ".yarvis",
  "AGENTS.md",
  "CLAUDE.md",
  ".DS_Store",
]);

/**
 * Deletes the workspace folder at `rootPath`. Without `force` it throws, naming
 * them, when anything other than Yarvis's own files is still there, so notes or
 * a stray checkout an agent left aren't lost without the user seeing them.
 *
 * `slug` bounds the delete: the folder must be named after it, and a slug is
 * one plain path segment, so a bad `rootPath` can't take a parent with it.
 */
export async function removeWorkspaceFolder(
  rootPath: string,
  slug: string,
  opts: { force: boolean },
): Promise<void> {
  if (!existsSync(rootPath)) return;
  if (!/^[a-z0-9-]+$/.test(slug) || basename(rootPath) !== slug) {
    throw new Error(`${rootPath} isn't named after its workspace, so it was left in place`);
  }
  const leftover = readdirSync(rootPath).filter((name) => !YARVIS_ROOT_ENTRIES.has(name));
  if (leftover.length > 0 && !opts.force) {
    throw new Error(
      `files are still in the workspace folder (${leftover.sort().join(", ")}) — force remove to delete them`,
    );
  }
  // Async: a leftover checkout can hold a `node_modules` tree.
  await rm(rootPath, { recursive: true, force: true });
}
