import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
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
 * worktree's admin directory, the object store, and its own branch and that
 * branch's remote-tracking ref, which a push updates. A fetch that would update
 * other remote-tracking refs asks. Everything that can make git run code, or
 * change what another workspace's git sees, is denied even where an allowed
 * path covers it. Yarvis's own git refuses a clone with a symlink in any of
 * these places (`symlinkScan.ts`), since it runs outside the sandbox and would
 * write through one.
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
 * matches, and when the worktree path is itself a symlink, which could stand in
 * for another workspace's worktree.
 */
export function resolveAdminName(clonePath: string, worktreePath: string): string | null {
  try {
    if (lstatSync(worktreePath).isSymbolicLink()) return null;
  } catch {
    return null;
  }
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
    const paths = [`${git}/objects`];
    if (isSafeBranch(branch)) {
      // Only the folders' leaves: a session that could create entries beside
      // them could plant a symlink for a later fetch to write through.
      paths.push(
        `${git}/refs/heads/${branch}`,
        `${git}/refs/heads/${branch}.lock`,
        `${git}/logs/refs/heads/${branch}`,
        `${git}/refs/remotes/origin/${branch}`,
        `${git}/refs/remotes/origin/${branch}.lock`,
        `${git}/logs/refs/remotes/origin/${branch}`,
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
 * sees (replaced objects, packed refs, the shared excludes, and tags, which
 * outrank remote-tracking refs when git resolves a short name like
 * `origin/main`, so a fetch that brings a new tag asks). The locks are
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
      "refs/tags",
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
  /^\.git\/(refs|logs\/refs)\/(heads|remotes\/origin)\/.+$/,
  /^\.git\/worktrees\/[^/]+(\/(commondir|gitdir|config\.worktree|modules))?$/,
];

/** True for a sandbox list entry Yarvis wrote for some repo clone. */
export function isOurSandboxEntry(entry: unknown): boolean {
  if (typeof entry !== "string") return false;
  const match = entry.match(/\/\.repos\/[^/]+\/(.+)$/);
  return match !== null && OUR_SUFFIXES.some((suffix) => suffix.test(match[1]!));
}

/**
 * Creates the directories the branch's loose refs and reflogs live in, for the
 * branch and its remote-tracking ref. The sandbox may write those files but not
 * create the folders above them, and packing refs removes a folder once it
 * empties, so without this a commit or push from inside the sandbox couldn't
 * write them.
 */
export function ensureBranchRefDirs({ clonePath, branch }: SandboxRepo): void {
  if (!isSafeBranch(branch)) return;
  const git = `${clonePath}/.git`;
  if (!existsSync(git)) return;
  for (const base of [
    `${git}/refs/heads`,
    `${git}/logs/refs/heads`,
    `${git}/refs/remotes/origin`,
    `${git}/logs/refs/remotes/origin`,
  ]) {
    mkdirSync(dirname(`${base}/${branch}`), { recursive: true });
  }
}
