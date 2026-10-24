import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { canonicalPath } from "./git.ts";

/**
 * What a workspace's Claude Code sandbox may write in each repo's clone.
 *
 * A worktree's git data lives in its repo's primary clone under `.repos/`,
 * outside the workspace folder the sandbox is limited to, so without these
 * every commit, rebase and push leaves the sandbox and asks the user. The clone
 * is shared by every workspace on that repo, and its `.git` decides what git
 * runs, so the grant is no wider than this workspace's own commits need: its
 * worktree's admin directory, the object store, its own branch, and the
 * remote-tracking refs and tags a fetch rewrites. Everything that can make git
 * run code, or change what another workspace's git sees, is denied even where
 * an allowed path covers it.
 */

/** One repo of a workspace, as the sandbox needs it. */
export interface SandboxRepo {
  /** The repo's primary clone, whose `.git` every worktree of the repo shares. */
  clonePath: string;
  /** The branch this workspace commits to. */
  branch: string;
  /** This worktree's directory under `.git/worktrees`, or null when it couldn't be matched. */
  adminName: string | null;
}

/** A name git might give a worktree's admin directory, and nothing that climbs out of it. */
const SAFE_SEGMENT = /^[A-Za-z0-9._-]+$/;

function isSafeSegment(segment: string): boolean {
  return SAFE_SEGMENT.test(segment) && segment !== "." && segment !== "..";
}

/** Branch names become paths under `refs/heads`, so every segment must be a plain one. */
function isSafeBranch(branch: string): boolean {
  return branch.split("/").every(isSafeSegment) && !branch.endsWith(".lock");
}

/**
 * The admin directory under `${clone}/.git/worktrees` whose `gitdir` file points
 * back at this worktree. Matched from the admin side because a session can
 * rewrite the worktree's own `.git` file, but not the admin directory's
 * `gitdir`, which the sandbox is denied. Null when none, or more than one,
 * matches.
 */
export function resolveAdminName(clonePath: string, worktreePath: string): string | null {
  const adminRoot = join(clonePath, ".git", "worktrees");
  let names: string[];
  try {
    names = readdirSync(adminRoot);
  } catch {
    return null;
  }
  const target = canonicalPath(worktreePath);
  const matches = names.filter((name) => {
    if (!isSafeSegment(name)) return false;
    try {
      const gitFile = readFileSync(join(adminRoot, name, "gitdir"), "utf8").trim();
      return canonicalPath(dirname(gitFile)) === target;
    } catch {
      return false;
    }
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** The sandbox's `allowWrite` entries for these repos. */
export function sandboxAllowWrite(repos: readonly SandboxRepo[]): string[] {
  return repos.flatMap(({ clonePath, branch, adminName }) => {
    const git = `${clonePath}/.git`;
    const paths = [
      `${git}/objects`,
      // Every fetch rewrites the remote-tracking refs and follows new tags. A
      // planted remote ref is overwritten by the fetch Yarvis runs before it
      // merges or cuts a worktree from one.
      `${git}/refs/remotes`,
      `${git}/logs/refs/remotes`,
      `${git}/refs/tags`,
    ];
    if (isSafeBranch(branch)) {
      paths.push(
        `${git}/refs/heads/${branch}`,
        `${git}/refs/heads/${branch}.lock`,
        `${git}/logs/refs/heads/${branch}`,
      );
    }
    if (adminName && isSafeSegment(adminName)) paths.push(`${git}/worktrees/${adminName}`);
    return paths;
  });
}

/**
 * The sandbox's `denyWrite` entries for these repos: what decides which
 * program git runs (config, hooks, submodule git directories), where it looks
 * for the repo (`commondir`, a worktree's `gitdir`), and what every workspace
 * sees (replaced objects, packed refs, the shared excludes). The locks are
 * denied too, so git fails to take one rather than leaving it behind. Packing
 * refs therefore fails inside the sandbox; git does that as housekeeping after
 * a commit and reports it without failing the commit.
 */
export function sandboxDenyWrite(repos: readonly SandboxRepo[]): string[] {
  return repos.flatMap(({ clonePath, adminName }) => {
    const git = `${clonePath}/.git`;
    const paths = [
      "config",
      "config.lock",
      "hooks",
      "commondir",
      "modules",
      "info",
      "refs/replace",
      "objects/info",
      "packed-refs",
      "packed-refs.lock",
    ].map((path) => `${git}/${path}`);
    if (adminName && isSafeSegment(adminName)) {
      const admin = `${git}/worktrees/${adminName}`;
      paths.push(
        ...["commondir", "gitdir", "config.worktree", "modules"].map((p) => `${admin}/${p}`),
      );
    }
    return paths;
  });
}

/**
 * What a path Yarvis writes into the sandbox lists looks like, after the clone's
 * `/.repos/<name>/`. A user's own entry never has this shape unless they wrote
 * one of these exact paths themselves. The first two are what an earlier
 * version granted.
 */
const OUR_SUFFIXES: RegExp[] = [
  /^\.git$/,
  /^\.claude\/worktrees$/,
  /^\.git\/(objects|objects\/info|refs\/remotes|logs\/refs\/remotes|refs\/tags|refs\/replace)$/,
  /^\.git\/(config|config\.lock|hooks|commondir|modules|info|packed-refs|packed-refs\.lock)$/,
  /^\.git\/(refs|logs\/refs)\/heads\/.+$/,
  /^\.git\/worktrees\/[^/]+(\/(commondir|gitdir|config\.worktree|modules))?$/,
];

/** True for a sandbox list entry Yarvis wrote for some repo clone. */
export function isOurSandboxEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  const match = entry.match(/\/\.repos\/[^/]+\/(.+)$/);
  return match !== null && OUR_SUFFIXES.some((suffix) => suffix.test(match[1]!));
}

/**
 * Creates the directories the branch's loose ref and reflog live in. The
 * sandbox may write the ref itself but not create the folders above it, and
 * packing refs removes a folder once it empties, so a branch named
 * `yarvis/<slug>` couldn't be committed to from inside the sandbox after one.
 */
export function ensureBranchRefDirs({ clonePath, branch }: SandboxRepo): void {
  if (!isSafeBranch(branch) || !branch.includes("/")) return;
  const git = `${clonePath}/.git`;
  if (!existsSync(git)) return;
  for (const base of [`${git}/refs/heads`, `${git}/logs/refs/heads`]) {
    mkdirSync(dirname(`${base}/${branch}`), { recursive: true });
  }
}
