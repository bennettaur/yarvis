/**
 * Git operations for the workspaces feature: managing a primary clone per repo
 * and cutting worktrees off the default branch.
 *
 * The runner is injectable so command construction can be unit-tested without a
 * real repo (mirrors how `github/client.ts` injects `fetch`). All paths are
 * absolute. The key safety rule baked in here: worktrees are always cut from
 * `origin/<default>` after a fetch — we never `checkout` or `pull` the primary
 * clone, so other worktrees referencing it are never disturbed and the
 * "branch already checked out" failure can't occur.
 */

import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { run } from "./exec.ts";

export interface GitRunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

/** Runs `git <args>`; `cwd` is the repo/worktree the command operates in. */
export type GitRunner = (
  args: string[],
  opts: { cwd?: string; timeoutMs?: number },
) => Promise<GitRunResult>;

/** Network git operations (clone/fetch) can legitimately take a while. */
const NETWORK_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * Real runner: shells out to `git` with a scrubbed env. `GIT_TERMINAL_PROMPT=0`
 * makes a missing-credential clone fail fast instead of hanging on a prompt the
 * headless sidecar can never answer.
 */
export const defaultGitRunner: GitRunner = (args, opts) =>
  run(["git", ...args], { ...opts, env: { GIT_TERMINAL_PROMPT: "0" } });

/** Runs a git command and throws a descriptive error on non-zero exit. */
export async function git(
  runner: GitRunner,
  args: string[],
  cwd?: string,
  timeoutMs?: number,
): Promise<string> {
  const result = await runner(args, { cwd, timeoutMs });
  if (result.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.trim()}`);
  }
  return result.stdout;
}

/** Clones the repo to `primaryClonePath` if it isn't already there. Idempotent. */
export async function ensurePrimaryClone(
  runner: GitRunner,
  cloneUrl: string,
  primaryClonePath: string,
): Promise<void> {
  if (existsSync(`${primaryClonePath}/.git`)) return;
  mkdirSync(dirname(primaryClonePath), { recursive: true });
  await git(runner, ["clone", cloneUrl, primaryClonePath], undefined, NETWORK_TIMEOUT_MS);
}

/**
 * Detects the repo's default branch from `origin/HEAD`. Sets the symbolic ref
 * first if it's missing. Returns null if it still can't be determined so the
 * caller can fall back (e.g. to "main").
 */
export async function detectDefaultBranch(
  runner: GitRunner,
  primaryClonePath: string,
): Promise<string | null> {
  const read = async (): Promise<string | null> => {
    const result = await runner(["symbolic-ref", "refs/remotes/origin/HEAD", "--short"], {
      cwd: primaryClonePath,
    });
    if (result.exitCode !== 0) return null;
    // e.g. "origin/main" -> "main"
    return result.stdout.trim().replace(/^origin\//, "") || null;
  };

  const first = await read();
  if (first) return first;

  // origin/HEAD can be unset (e.g. after a partial fetch); ask git to set it.
  await runner(["remote", "set-head", "origin", "--auto"], { cwd: primaryClonePath });
  return read();
}

/** Fetches the latest default branch into the remote-tracking ref. No checkout. */
export async function updateDefaultBranch(
  runner: GitRunner,
  primaryClonePath: string,
  defaultBranch: string,
): Promise<void> {
  await git(
    runner,
    ["fetch", "origin", defaultBranch, "--prune"],
    primaryClonePath,
    NETWORK_TIMEOUT_MS,
  );
}

/** True if a local branch already exists in the primary clone. */
export async function branchExists(
  runner: GitRunner,
  primaryClonePath: string,
  branch: string,
): Promise<boolean> {
  const result = await runner(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], {
    cwd: primaryClonePath,
  });
  return result.exitCode === 0;
}

/**
 * Creates a worktree at `worktreePath` on a new branch cut from
 * `origin/<baseBranch>`. Prunes stale worktree metadata first so a path freed
 * by an out-of-band folder delete can be reused.
 */
export async function createWorktree(
  runner: GitRunner,
  primaryClonePath: string,
  worktreePath: string,
  newBranch: string,
  baseBranch: string,
): Promise<void> {
  await git(runner, ["worktree", "prune"], primaryClonePath);
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git(
    runner,
    ["worktree", "add", "-b", newBranch, worktreePath, `origin/${baseBranch}`],
    primaryClonePath,
  );
}

/** Removes a worktree and prunes its metadata. `force` discards uncommitted work. */
export async function removeWorktree(
  runner: GitRunner,
  primaryClonePath: string,
  worktreePath: string,
  opts: { force: boolean },
): Promise<void> {
  const args = ["worktree", "remove", ...(opts.force ? ["--force"] : []), worktreePath];
  await git(runner, args, primaryClonePath);
  await git(runner, ["worktree", "prune"], primaryClonePath);
}

/** All tracked files in the worktree (`git ls-files`). */
export async function listFiles(runner: GitRunner, worktreePath: string): Promise<string[]> {
  const out = await git(runner, ["ls-files"], worktreePath);
  return out.split("\n").filter(Boolean);
}

export interface ChangedFile {
  path: string;
  /** "added" | "modified" | "deleted" | "renamed" | "untracked". */
  status: string;
  additions: number;
  deletions: number;
}

const STATUS_LETTERS: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
};

/**
 * Files changed on this branch versus its base, including uncommitted work and
 * untracked files. Diffs the working tree against `origin/<baseBranch>` (two-dot,
 * so committed + uncommitted are both captured), then appends untracked files.
 */
export async function listChangedFiles(
  runner: GitRunner,
  worktreePath: string,
  baseBranch: string,
): Promise<ChangedFile[]> {
  const base = `origin/${baseBranch}`;
  const byPath = new Map<string, ChangedFile>();

  // name-status gives the change kind (A/M/D/R…).
  const nameStatus = await git(runner, ["diff", "--name-status", base], worktreePath);
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0] ?? "";
    // Renames/copies are "R100\told\tnew" — the new path is the last column.
    const path = parts[parts.length - 1] ?? "";
    if (!path) continue;
    byPath.set(path, {
      path,
      status: STATUS_LETTERS[code[0] ?? ""] ?? "modified",
      additions: 0,
      deletions: 0,
    });
  }

  // numstat gives line counts ("-" for binary).
  const numstat = await git(runner, ["diff", "--numstat", base], worktreePath);
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [add, del, ...rest] = line.split("\t");
    const path = rest[rest.length - 1] ?? "";
    if (!path) continue;
    const entry = byPath.get(path) ?? { path, status: "modified", additions: 0, deletions: 0 };
    entry.additions = add === "-" ? 0 : Number(add) || 0;
    entry.deletions = del === "-" ? 0 : Number(del) || 0;
    byPath.set(path, entry);
  }

  const untracked = await git(runner, ["ls-files", "--others", "--exclude-standard"], worktreePath);
  for (const path of untracked.split("\n").filter(Boolean)) {
    if (!byPath.has(path)) {
      byPath.set(path, { path, status: "untracked", additions: 0, deletions: 0 });
    }
  }

  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}
