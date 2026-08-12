/**
 * Git operations for the workspaces feature: managing a primary clone per repo
 * and cutting worktrees off the default branch.
 *
 * The runner is injectable so command construction can be unit-tested without a
 * real repo (mirrors how `github/client.ts` injects `fetch`). All paths are
 * absolute. The key safety rule baked in here: worktrees are always cut from
 * `origin/<default>` after a fetch — we never `checkout` or `pull` the primary
 * clone, so other worktrees referencing it are never disturbed and the
 * "branch already checked out" failure can't occur. Working-tree mutations
 * (merge, push) likewise run in a worktree, never in the primary clone.
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
async function git(
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

/**
 * Fetches every remote ref (branches + the base) into the remote-tracking refs,
 * pruning deleted ones. Used before computing branch divergence so the
 * push/pull counts reflect the current remote. No checkout, so worktrees are
 * undisturbed.
 */
export async function fetchRemote(runner: GitRunner, primaryClonePath: string): Promise<void> {
  await git(runner, ["fetch", "origin", "--prune"], primaryClonePath, NETWORK_TIMEOUT_MS);
}

/** How a branch has diverged from its remote and its base, for push/pull hints. */
export interface BranchSync {
  /** Local commits not yet on the remote branch — changes to push. */
  ahead: number;
  /** Remote-branch commits missing locally — changes to pull. 0 until pushed. */
  behind: number;
  /** Commits the base branch has moved on by since this branch — pull/rebase. */
  baseBehind: number;
  /** Whether the branch has been pushed (a remote-tracking branch exists). */
  hasRemote: boolean;
}

/**
 * Counts how far this branch is ahead/behind its remote and its base, from the
 * remote-tracking refs (call `fetchRemote` first for fresh counts). Before the
 * branch is pushed there is no `origin/<branch>`, so `ahead` falls back to the
 * commits it carries over its base and `behind` is 0. `baseBehind` measures how
 * far the base has advanced past this branch — the "pull is the priority" signal.
 */
export async function branchSync(
  runner: GitRunner,
  worktreePath: string,
  branch: string,
  baseBranch: string,
): Promise<BranchSync> {
  const remoteBranch = `origin/${branch}`;
  const base = `origin/${baseBranch}`;

  const count = async (range: string): Promise<number> => {
    const out = await git(runner, ["rev-list", "--count", range], worktreePath);
    return Number(out.trim()) || 0;
  };

  const remoteCheck = await runner(
    ["rev-parse", "--verify", "--quiet", `refs/remotes/${remoteBranch}`],
    { cwd: worktreePath },
  );
  const hasRemote = remoteCheck.exitCode === 0;

  const baseBehind = await count(`HEAD..${base}`);
  if (hasRemote) {
    return {
      ahead: await count(`${remoteBranch}..HEAD`),
      behind: await count(`HEAD..${remoteBranch}`),
      baseBehind,
      hasRemote: true,
    };
  }
  return { ahead: await count(`${base}..HEAD`), behind: 0, baseBehind, hasRemote: false };
}

/** What stands in the way of merging into a worktree, if anything. */
export interface WorktreeStatus {
  /** Tracked files with staged or unstaged modifications, conflicts included.
   *  Untracked files are excluded: they don't block a merge. */
  dirtyFiles: string[];
  /** True when a merge is already under way (`MERGE_HEAD` present). */
  mergeInProgress: boolean;
}

/**
 * The worktree state a merge cares about. Read before merging so a sync can say
 * *why* it left a branch alone rather than merging on top of work in progress.
 */
export async function worktreeStatus(
  runner: GitRunner,
  worktreePath: string,
): Promise<WorktreeStatus> {
  const porcelain = await git(runner, ["status", "--porcelain"], worktreePath);
  const dirtyFiles = porcelain
    .split("\n")
    .filter((line) => line.trim() && !line.startsWith("??"))
    // Porcelain v1 is "XY <path>"; a rename is "R  old -> new".
    .map((line) => line.slice(3).split(" -> ").pop() ?? "")
    .filter(Boolean);

  const mergeHead = await runner(["rev-parse", "--verify", "--quiet", "MERGE_HEAD"], {
    cwd: worktreePath,
  });
  return { dirtyFiles, mergeInProgress: mergeHead.exitCode === 0 };
}

/** The outcome of merging a base branch into a worktree's branch. */
export type MergeOutcome =
  | { result: "up-to-date" }
  | { result: "merged" }
  /** The merge stopped on conflicts and was *left in place* — see `mergeBaseIntoWorktree`. */
  | { result: "conflict"; files: string[] };

/**
 * Merges `origin/<baseBranch>` into whatever the worktree has checked out. Fetch
 * the base first (see `fetchRemote`) or this merges a stale ref.
 *
 * A conflicted merge is deliberately left in the worktree rather than aborted:
 * the conflict markers are what an agent session started in that worktree needs
 * in order to resolve them, and a caller that wanted the branch untouched can
 * check `worktreeStatus` first. A merge that fails for any other reason throws,
 * since only conflicts have a defined half-done state.
 */
export async function mergeBaseIntoWorktree(
  runner: GitRunner,
  worktreePath: string,
  baseBranch: string,
): Promise<MergeOutcome> {
  const result = await runner(["merge", "--no-edit", `origin/${baseBranch}`], {
    cwd: worktreePath,
  });
  if (result.exitCode === 0) {
    return /already up to date/i.test(result.stdout)
      ? { result: "up-to-date" }
      : { result: "merged" };
  }

  const conflicted = await git(runner, ["diff", "--name-only", "--diff-filter=U"], worktreePath);
  const files = conflicted.split("\n").filter(Boolean);
  if (files.length) return { result: "conflict", files };

  throw new Error(
    `git merge origin/${baseBranch} failed (${result.exitCode}): ${result.stderr.trim()}`,
  );
}

/** Pushes the branch to origin, setting it as upstream so later pushes need no args. */
export async function pushBranch(
  runner: GitRunner,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(runner, ["push", "--set-upstream", "origin", branch], worktreePath, NETWORK_TIMEOUT_MS);
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

/** Fetches a single branch into its `origin/<branch>` remote-tracking ref. No checkout. */
export async function fetchBranch(
  runner: GitRunner,
  primaryClonePath: string,
  branch: string,
): Promise<void> {
  await git(runner, ["fetch", "origin", branch], primaryClonePath, NETWORK_TIMEOUT_MS);
}

/**
 * The names of the repo's remote branches (from `origin/*`, minus `origin/HEAD`),
 * for offering an existing branch to check out. Call `fetchRemote` first so the
 * list reflects the current remote.
 */
export async function listRemoteBranches(
  runner: GitRunner,
  primaryClonePath: string,
): Promise<string[]> {
  const out = await git(
    runner,
    ["for-each-ref", "--format=%(refname:short)", "refs/remotes/origin"],
    primaryClonePath,
  );
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((ref) => ref && ref !== "origin/HEAD")
    .map((ref) => ref.replace(/^origin\//, ""));
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

/**
 * Creates a worktree at `worktreePath` checked out on an existing branch. Passing
 * the bare branch name lets git's DWIM create a local branch tracking
 * `origin/<branch>` when none exists locally, or reuse the local branch if it
 * does — so a branch pushed by someone else, or left by a prior workspace, is
 * picked up. Fetch `origin/<branch>` first (see `fetchBranch`). Prunes stale
 * worktree metadata so a path freed by an out-of-band folder delete can be reused.
 */
export async function addExistingBranchWorktree(
  runner: GitRunner,
  primaryClonePath: string,
  worktreePath: string,
  branch: string,
): Promise<void> {
  await git(runner, ["worktree", "prune"], primaryClonePath);
  mkdirSync(dirname(worktreePath), { recursive: true });
  await git(runner, ["worktree", "add", worktreePath, branch], primaryClonePath);
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

/**
 * Resolves the ref to diff a worktree's branch against: the merge-base of
 * `origin/<baseBranch>` and the worktree's `HEAD` — i.e. the commit the branch
 * was cut from. Diffing against this start ref rather than `origin/<baseBranch>`
 * directly keeps the "files changed" view stable when origin advances past the
 * branch point: new upstream commits aren't ancestors of HEAD, so the merge-base
 * doesn't move and they never show up as spurious deletions.
 *
 * Falls back to `origin/<baseBranch>` when no merge-base exists (unrelated
 * histories) so callers always get a usable ref.
 */
async function resolveDiffBase(
  runner: GitRunner,
  worktreePath: string,
  baseBranch: string,
): Promise<string> {
  const remoteBase = `origin/${baseBranch}`;
  const result = await runner(["merge-base", remoteBase, "HEAD"], { cwd: worktreePath });
  if (result.exitCode !== 0) return remoteBase;
  return result.stdout.trim() || remoteBase;
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
 * untracked files. Diffs the working tree against the branch's start ref (the
 * merge-base with `origin/<baseBranch>`, two-dot so committed + uncommitted are
 * both captured), then appends untracked files.
 */
export async function listChangedFiles(
  runner: GitRunner,
  worktreePath: string,
  baseBranch: string,
): Promise<ChangedFile[]> {
  const base = await resolveDiffBase(runner, worktreePath, baseBranch);
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

/**
 * The unified-diff patch for a single changed file versus the branch's start ref
 * (the merge-base with `origin/<baseBranch>`), matching the two-dot range used by
 * `listChangedFiles` so committed and uncommitted work both show. Untracked files
 * have no base to diff against, so they fall back to a `--no-index` diff of
 * `/dev/null` against the file, which renders their whole contents as additions.
 * Returns an empty string when there is no textual diff (unchanged, or a binary
 * file). `--` separates the pathspec so a filename can never be read as a git
 * option.
 */
export async function fileDiff(
  runner: GitRunner,
  worktreePath: string,
  baseBranch: string,
  path: string,
): Promise<string> {
  const base = await resolveDiffBase(runner, worktreePath, baseBranch);
  const tracked = await git(runner, ["diff", base, "--", path], worktreePath);
  if (tracked.trim()) return tracked;

  // `git diff --no-index` exits 1 when the files differ — the normal outcome for
  // a new file — so only a code above 1 signals a real failure.
  const untracked = await runner(["diff", "--no-index", "--", "/dev/null", path], {
    cwd: worktreePath,
  });
  if (untracked.exitCode > 1) {
    throw new Error(
      `git diff --no-index failed (${untracked.exitCode}): ${untracked.stderr.trim()}`,
    );
  }
  return untracked.stdout;
}
