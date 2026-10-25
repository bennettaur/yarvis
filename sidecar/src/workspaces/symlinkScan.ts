import { lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Looks for symlinks in a clone's git data before Yarvis runs git on it.
 *
 * A workspace session's sandbox may write parts of the clone's `.git`
 * (`sandboxPaths.ts`), and Yarvis's own git runs outside that sandbox. A
 * symlink the session left there would make Yarvis's git write wherever it
 * points: a fetch through a linked ref directory moves another workspace's
 * branch, and a merge through a linked `MERGE_MSG` overwrites the file behind
 * it. git never creates symlinks in its own data, so any one found is refused.
 *
 * Only the places the sandbox can write, or that git writes through, are
 * walked: every top-level entry, `refs`, `logs`, each worktree's admin
 * directory, and the object store's top two levels (git writes objects by
 * rename into those folders). That keeps it to a few thousand `lstat` calls on
 * a large clone. It is checked right before each command, so a session that
 * keeps running can still plant a link between the check and the write.
 */

export interface SymlinkFinding {
  problem: string;
  where: string;
}

/** Stops a clone with a pathological number of refs from stalling every git call. */
const MAX_ENTRIES = 200_000;

/** The folders walked in full, relative to the git directory. */
const WALKED = ["refs", "logs", "worktrees"];

/**
 * The git directory a command run in `cwd` uses: `cwd/.git` for a clone, or the
 * clone's `.git` for a worktree (its `.git` file names `<clone>/.git/worktrees/<name>`).
 * Null when `cwd` isn't a repo root, which means there is nothing to scan.
 */
export function commonGitDirFor(cwd: string): string | null {
  const dotGit = join(cwd, ".git");
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  if (!stat.isFile()) return dotGit;
  try {
    const match = readFileSync(dotGit, "utf8").match(/^gitdir: (.+)$/m);
    if (!match) return null;
    const gitDir = resolve(cwd, match[1]!.trim());
    // A worktree's admin directory sits two levels under the shared one.
    return /[\\/]worktrees[\\/][^\\/]+$/.test(gitDir) ? dirname(dirname(gitDir)) : gitDir;
  } catch {
    return null;
  }
}

/** Symlinks in `gitDir` where Yarvis's git would write through them. */
export function scanGitDirForSymlinks(gitDir: string): SymlinkFinding[] {
  const findings: SymlinkFinding[] = [];
  let visited = 0;
  const flag = (path: string) =>
    findings.push({ problem: "a symlink in the clone's git data", where: path });

  const isLink = (path: string): boolean | null => {
    visited++;
    try {
      return lstatSync(path).isSymbolicLink();
    } catch {
      return null;
    }
  };

  const children = (dir: string): string[] => {
    try {
      return readdirSync(dir);
    } catch {
      return [];
    }
  };

  const walk = (dir: string) => {
    for (const name of children(dir)) {
      if (visited > MAX_ENTRIES) return;
      const path = join(dir, name);
      const link = isLink(path);
      if (link) flag(path);
      else if (link === false && lstatSync(path).isDirectory()) walk(path);
    }
  };

  if (isLink(gitDir)) {
    flag(gitDir);
    return findings;
  }
  for (const name of children(gitDir)) {
    const path = join(gitDir, name);
    if (isLink(path)) flag(path);
  }
  for (const name of WALKED) {
    const path = join(gitDir, name);
    if (isLink(path) === false) walk(path);
  }
  const objects = join(gitDir, "objects");
  if (isLink(objects) === false) {
    for (const name of children(objects)) {
      const path = join(objects, name);
      const link = isLink(path);
      if (link) flag(path);
      else if (link === false && lstatSync(path).isDirectory()) {
        for (const child of children(path)) {
          if (isLink(join(path, child))) flag(join(path, child));
        }
      }
    }
  }
  if (visited > MAX_ENTRIES) {
    findings.push({ problem: "too many entries to check the clone's git data", where: gitDir });
  }
  return findings;
}

/** Told about every refused command, so the workspaces it belongs to can be flagged. */
type SymlinkHandler = (gitDir: string, findings: SymlinkFinding[]) => void;

let handler: SymlinkHandler | null = null;

export function setSymlinkHandler(next: SymlinkHandler | null): void {
  handler = next;
}

/**
 * The reason to refuse a git command run in `cwd`, or null when its git data
 * has no symlinks. Reports the refusal to the handler and the log.
 */
export function symlinkRefusal(cwd: string | undefined): string | null {
  if (!cwd) return null;
  const gitDir = commonGitDirFor(cwd);
  if (!gitDir) return null;
  const findings = scanGitDirForSymlinks(gitDir);
  if (findings.length === 0) return null;
  let canonical = gitDir;
  try {
    canonical = realpathSync(gitDir);
  } catch {
    // Report the path as found.
  }
  console.error(
    `[workspaces] refused to run git in ${cwd}: ${findings.map((f) => f.where).join(", ")}`,
  );
  try {
    handler?.(canonical, findings);
  } catch (e) {
    console.error("[workspaces] reporting a symlink in git data failed:", e);
  }
  return `refused: the clone's git data has a symlink (${findings[0]!.where}); Yarvis won't run git on it until it's removed`;
}
