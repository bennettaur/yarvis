/**
 * Deleting a workspace's own folder once its worktrees are gone, so an archive
 * leaves nothing behind in the workspaces root.
 */

import { existsSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename } from "node:path";
import { userClaudeEntries } from "./claudeAssets.ts";

/**
 * What Yarvis writes at a workspace root, plus Finder's `.DS_Store`. `.claude`
 * is shared with the user, so what they put in it is checked separately.
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
 * Deletes the workspace folder at `rootPath`. Without `force`, it throws if
 * anything besides Yarvis's own files is still there, listing those entries, so
 * notes or a stray checkout an agent left aren't lost without the user seeing
 * them.
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
  const leftover = [
    ...readdirSync(rootPath).filter((name) => !YARVIS_ROOT_ENTRIES.has(name)),
    ...userClaudeEntries(rootPath).map((entry) => `.claude/${entry}`),
  ];
  if (leftover.length > 0 && !opts.force) {
    throw new Error(
      `files are still in the workspace folder (${leftover.sort().join(", ")}) — force remove to delete them`,
    );
  }
  // Async, so deleting a leftover checkout's `node_modules` doesn't stall every
  // other request the sidecar is serving.
  await rm(rootPath, { recursive: true, force: true });
}
