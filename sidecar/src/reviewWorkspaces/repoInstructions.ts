/**
 * The repo's own review instructions for the repo verification check: its
 * `AGENTS.md` and `CLAUDE.md`, and the skills, agents and commands under
 * `.claude/`, read from git objects at the base branch's tip and written into
 * the run's context folder as plain files.
 *
 * They come from the default branch's tip whatever the PR's base, so a PR
 * can't rewrite the instructions that review it, and neither can a lower
 * layer of its stack, whose branch its author wrote. They are never loaded as
 * Claude Code project settings, which would also load the checkout's hooks
 * and permissions.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { git, NETWORK_TIMEOUT_MS, remoteRef, splitNulFields } from "../workspaces/git.ts";
import { readFileAt } from "./git.ts";
import { type ReadyPr, withCloneLock } from "./service.ts";

/** Folder under the context directory the files are written to, mirroring their repo paths. */
export const REPO_INSTRUCTIONS_DIR = "repo";

const ROOT_FILES = ["AGENTS.md", "CLAUDE.md", ".claude/CLAUDE.md"];
const CLAUDE_FOLDERS = [".claude/skills/", ".claude/agents/", ".claude/commands/"];

/** Enough for a repo's guidance and a handful of skills; past this the rest is listed as left out. */
const MAX_FILES = 40;
const MAX_FILE_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 512 * 1024;

export interface RepoInstructions {
  /** The default branch the files were read from. */
  branch: string;
  /** The commit they were read at. */
  commit: string;
  /** Repo paths written, root files first. */
  files: string[];
  /** Matching files left out: binary, too large, or past the count or size cap. */
  omitted: number;
}

export class RepoInstructionsError extends Error {}

function isInstructionFile(path: string): boolean {
  return ROOT_FILES.includes(path) || CLAUDE_FOLDERS.some((folder) => path.startsWith(folder));
}

/** Root files first, so a cap cuts skills rather than the repo's main guidance. */
function readingOrder(a: string, b: string): number {
  const rank = (p: string) => (ROOT_FILES.includes(p) ? ROOT_FILES.indexOf(p) : ROOT_FILES.length);
  return rank(a) - rank(b) || a.localeCompare(b);
}

/**
 * The remote's default branch as the review clone recorded it when it was
 * cloned, for a repo whose registration hasn't detected one yet.
 */
async function cloneDefaultBranch(ready: Pick<ReadyPr, "runners" | "clonePath">) {
  const result = await ready.runners.local(
    ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"],
    { cwd: ready.clonePath },
  );
  const ref = result.stdout.trim();
  return result.exitCode === 0 && ref.startsWith("refs/remotes/origin/")
    ? ref.slice("refs/remotes/origin/".length)
    : null;
}

/**
 * The default branch's tip. A PR into it already has that commit, fetched with
 * the PR; a stacked layer's base is another branch, so the default branch is
 * fetched for it.
 */
async function defaultBranchTip(
  ready: Pick<ReadyPr, "runners" | "clonePath" | "pr">,
  branch: string,
): Promise<string> {
  const { baseRef, baseSha } = ready.pr;
  if (baseRef === branch && baseSha) return baseSha;
  const valid = await ready.runners.local(["check-ref-format", "--branch", branch], {
    cwd: ready.clonePath,
  });
  if (valid.exitCode !== 0 || branch.startsWith("-")) {
    throw new RepoInstructionsError(
      `the default branch name ${JSON.stringify(branch)} isn't valid`,
    );
  }
  const ref = remoteRef(branch);
  await withCloneLock(ready.clonePath, () =>
    git(
      ready.runners.network,
      ["fetch", "--no-tags", "origin", `+refs/heads/${branch}:${ref}`],
      ready.clonePath,
      NETWORK_TIMEOUT_MS,
    ),
  );
  return (
    await git(
      ready.runners.local,
      ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`],
      ready.clonePath,
    )
  ).trim();
}

/**
 * Writes the instructions under `<contextDir>/repo/`. Throws a
 * {@link RepoInstructionsError} the user can act on when the default branch
 * isn't known, or its registration and the remote disagree on it.
 */
export async function writeRepoInstructions(
  ready: Pick<ReadyPr, "runners" | "clonePath" | "pr">,
  registeredDefaultBranch: string | null,
  contextDir: string,
): Promise<RepoInstructions> {
  const cloned = await cloneDefaultBranch(ready);
  const defaultBranch = registeredDefaultBranch ?? cloned;
  if (!defaultBranch) {
    throw new RepoInstructionsError("the repo's default branch isn't known");
  }
  // A registration from before the repo changed its default branch would
  // trust a branch that may no longer be protected.
  if (cloned && cloned !== defaultBranch) {
    throw new RepoInstructionsError(
      `the repo's registered default branch ${defaultBranch} doesn't match its remote's ${cloned}`,
    );
  }
  const commit = await defaultBranchTip(ready, defaultBranch);

  const paths = splitNulFields(
    await git(ready.runners.local, ["ls-tree", "-r", "-z", "--name-only", commit], ready.clonePath),
  )
    .filter(isInstructionFile)
    .sort(readingOrder);
  const files: string[] = [];
  let total = 0;
  let omitted = 0;
  for (const path of paths) {
    if (files.length >= MAX_FILES) {
      omitted++;
      continue;
    }
    const file = await readFileAt(ready.runners, ready.clonePath, commit, path, MAX_FILE_BYTES);
    if (!file || file.binary || file.tooLarge || total + file.size > MAX_TOTAL_BYTES) {
      omitted++;
      continue;
    }
    const target = join(contextDir, REPO_INSTRUCTIONS_DIR, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, file.content);
    files.push(path);
    total += file.size;
  }
  return { branch: defaultBranch, commit, files, omitted };
}
