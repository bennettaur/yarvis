/**
 * Puts a review clone's git configuration back the way it was after a PR's
 * setup script has run.
 *
 * Setup runs the PR's own code (a `postinstall`, say) in a linked worktree,
 * and a linked worktree's git dir is the shared clone's. Code running there can
 * write config, hooks or attributes that a later git command would act on —
 * one that carries the provider token, or one run for a different PR the user
 * never agreed to run anything for. The hardening config on every review git
 * call (`git.ts`) switches most of that off, but not keys git has no off switch
 * for (`include.path`, `url.*.insteadOf`, `filter.*`), so the files that hold
 * them are snapshotted before the script and restored after it.
 *
 * This is defence in depth, not a sandbox: the script runs as the user and can
 * reach anything they can. The alternative — running setup in a copy of the
 * worktree with no link to the clone — would leave code navigation looking at
 * a checkout without the installed dependencies, which is most of the reason to
 * run setup at all, and would double the disk a review takes.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

type Entry = { kind: "file"; data: Buffer } | { kind: "link"; target: string } | { kind: "dir" };

/** What a path held: nothing, or a tree of entries keyed by relative path. */
type Snapshot = Map<string, Entry> | null;

export interface GitStateSnapshot {
  paths: Map<string, Snapshot>;
}

function capture(root: string): Snapshot {
  if (!existsSync(root) && !isLink(root)) return null;
  const entries = new Map<string, Entry>();
  const walk = (rel: string) => {
    const full = rel ? join(root, rel) : root;
    const stat = lstatSync(full);
    if (stat.isSymbolicLink()) entries.set(rel, { kind: "link", target: readlinkSync(full) });
    else if (stat.isDirectory()) {
      entries.set(rel, { kind: "dir" });
      for (const name of readdirSync(full)) walk(rel ? join(rel, name) : name);
    } else entries.set(rel, { kind: "file", data: readFileSync(full) });
  };
  walk("");
  return entries;
}

function isLink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function same(a: Snapshot, b: Snapshot): boolean {
  if (a === null || b === null) return a === b;
  if (a.size !== b.size) return false;
  for (const [rel, entry] of a) {
    const other = b.get(rel);
    if (!other || other.kind !== entry.kind) return false;
    if (entry.kind === "file" && other.kind === "file" && !entry.data.equals(other.data)) {
      return false;
    }
    if (entry.kind === "link" && other.kind === "link" && entry.target !== other.target) {
      return false;
    }
  }
  return true;
}

/** Puts `snapshot` back at `root`. `rmSync` removes a symlink itself, never its target. */
function restore(root: string, snapshot: Snapshot): void {
  rmSync(root, { recursive: true, force: true });
  if (snapshot === null) return;
  for (const [rel, entry] of snapshot) {
    const full = rel ? join(root, rel) : root;
    if (entry.kind === "dir") mkdirSync(full, { recursive: true });
    else if (entry.kind === "link") symlinkSync(entry.target, full);
    else {
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, entry.data);
    }
  }
}

/**
 * The worktree's own admin directory inside the clone, from its `.git` file,
 * or null when that file doesn't point inside `<clone>/.git/worktrees`.
 */
function worktreeAdminDir(commonDir: string, worktreePath: string): string | null {
  try {
    const line = readFileSync(join(worktreePath, ".git"), "utf8").trim();
    const target = resolve(worktreePath, line.replace(/^gitdir:\s*/, ""));
    const rel = relative(join(commonDir, "worktrees"), target);
    return rel && !isAbsolute(rel) && !rel.startsWith("..") && !rel.includes(sep) ? target : null;
  } catch {
    return null;
  }
}

/** The paths a setup script could use to change what later git commands do. */
function guardedPaths(clonePath: string, worktreePath: string): string[] {
  const common = join(clonePath, ".git");
  const admin = worktreeAdminDir(common, worktreePath);
  return [
    join(common, "config"),
    join(common, "config.worktree"),
    join(common, "hooks"),
    join(common, "info"),
    // Where the worktree's `.git` file says its git dir is: rewritten, it would
    // point the next checkout at a repository of the script's choosing.
    join(worktreePath, ".git"),
    ...(admin
      ? [join(admin, "config.worktree"), join(admin, "commondir"), join(admin, "gitdir")]
      : []),
  ];
}

export function snapshotGitState(clonePath: string, worktreePath: string): GitStateSnapshot {
  return {
    paths: new Map(guardedPaths(clonePath, worktreePath).map((path) => [path, capture(path)])),
  };
}

/** Restores every guarded path that changed, and answers with the ones it put back. */
export function restoreGitState(snapshot: GitStateSnapshot): string[] {
  const restored: string[] = [];
  for (const [path, before] of snapshot.paths) {
    if (same(before, capture(path))) continue;
    restore(path, before);
    restored.push(path);
  }
  return restored;
}
