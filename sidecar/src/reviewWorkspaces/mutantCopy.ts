/**
 * Scratch copies for mutation testing. Mutants are edits to the code, and the
 * review checkout is what the reviewer is reading, so mutants never touch it:
 * each run gets its own copy of the PR's worktree, dependencies and all, next
 * to it in the review workspace's folder:
 *
 *   .review/<workspace id>/<refDomKey>-mutants-<copy id>
 *
 * On APFS the copy is a clonefile (`cp -c`), which shares blocks with the
 * original until either side writes, so even a large `node_modules` costs
 * almost nothing. Anywhere else it is a plain copy.
 *
 * The copy is made its own git repository with one commit of what it holds, so
 * the agent's `git diff` shows exactly its current mutant and `git checkout --`
 * reverts it. Copied as is, the worktree's `.git` file would point the copy at
 * the review checkout's own index and HEAD, so a revert in the copy would act
 * on the review checkout's git state.
 *
 * Copies are removed when their run ends, however it ends; the startup sweep
 * removes what a crashed sidecar left.
 */

import { lstatSync, readdirSync, readlinkSync, realpathSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns, type ReviewWorkspacePr } from "../db/schema.ts";
import { type RunResult, run } from "../workspaces/exec.ts";
import { type GitRunner, git } from "../workspaces/git.ts";
import { reviewGit } from "./git.ts";
import { assertWorktreeInWorkspace, reviewWorkspaceDir, reviewWorkspacesRoot } from "./service.ts";

/**
 * The run kind mutation tests are stored under. Defined here rather than with
 * the runs in `mutationTesting.ts` because the sweep below looks runs up by it,
 * and `mutationTesting.ts` already imports this module.
 */
export const MUTATION_RUN_KIND = "mutation";

const COPY_NAME = /^(.+)-mutants-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/**
 * Files at the top of the copy that would speak to the agent as instructions
 * or configuration rather than as code. The run reads no settings, but these
 * are what a PR would plant to try anyway, and no test needs them.
 */
const AGENT_FILES = ["CLAUDE.md", "CLAUDE.local.md", "AGENTS.md", ".claude"];

/** Copying a large tree without clonefile, or committing it, can take a while. */
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A copy with no run row yet may be one another instance is still making;
 * past this age it is a leftover.
 */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

type CopyMethod = "clonefile" | "copy";

interface MutantCopy {
  path: string;
  method: CopyMethod;
}

export interface MutantCopyDeps {
  /** Runs `cp`; injectable so tests can make clonefile fail. */
  run?: (args: string[], opts: { timeoutMs?: number }) => Promise<RunResult>;
  git?: GitRunner;
  platform?: NodeJS.Platform;
}

type CopiedPr = Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">;

export function mutantCopyPath(
  config: Pick<Config, "workspacesRoot">,
  pr: CopiedPr,
  copyId: string,
): string {
  return join(
    reviewWorkspaceDir(config, pr.workspaceId),
    `${basename(pr.worktreePath)}-mutants-${copyId}`,
  );
}

/**
 * Throws unless `path` is a mutant copy's path directly in its workspace's
 * folder. Checked before anything is copied to or deleted from it.
 */
function assertCopyPath(config: Pick<Config, "workspacesRoot">, workspaceId: string, path: string) {
  const resolved = resolve(path);
  if (dirname(resolved) !== resolve(reviewWorkspaceDir(config, workspaceId))) {
    throw new Error(`${path} is not in its review workspace's folder`);
  }
  if (!COPY_NAME.test(basename(resolved))) throw new Error(`${path} is not a mutant copy`);
}

/** Whether `path` exists as a directory and not as a symlink to one. */
function isRealDirectory(path: string): boolean {
  try {
    const stat = lstatSync(path);
    return stat.isDirectory() && !stat.isSymbolicLink();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Removes every symlink in the copy that leads out of it. A link into the
 * review checkout — an absolute one a setup script wrote, say — would hand
 * the agent's edits and the tests' writes straight to the code the reviewer is
 * reading. Links that stay inside, like `node_modules/.bin`, are kept. A
 * dangling link is judged by where it points.
 */
async function removeOutwardLinks(path: string): Promise<string[]> {
  const found = await run(["find", path, "-type", "l", "-print0"], { timeoutMs: COPY_TIMEOUT_MS });
  if (found.exitCode !== 0) throw new Error(`could not list symlinks: ${found.stderr.trim()}`);
  const root = realpathSync(path);
  const removed: string[] = [];
  for (const link of found.stdout.split("\0").filter(Boolean)) {
    let target: string;
    try {
      target = realpathSync(link);
    } catch {
      target = resolve(realpathSync(dirname(link)), readlinkSync(link));
    }
    const inside = relative(root, target);
    if (inside === "" || (!inside.startsWith("..") && !isAbsolute(inside))) continue;
    await rm(link, { force: true });
    removed.push(relative(path, link));
  }
  return removed;
}

/**
 * Copies the PR's worktree, including whatever its setup installed, and turns
 * the copy into a standalone repository. Refuses, and removes the copy, unless
 * both the worktree and the copy are still at `headSha` once it is made, so a
 * copy can't be of some other commit than the one consent was given for.
 */
export async function createMutantCopy(
  config: Pick<Config, "workspacesRoot">,
  pr: CopiedPr,
  copyId: string,
  headSha: string,
  deps: MutantCopyDeps = {},
): Promise<MutantCopy> {
  const runCp = deps.run ?? run;
  const gitRunner = deps.git ?? reviewGit().local;
  const platform = deps.platform ?? process.platform;

  assertWorktreeInWorkspace(config, pr);
  const source = resolve(pr.worktreePath);
  if (!isRealDirectory(source)) throw new Error(`no checkout at ${pr.worktreePath}`);
  const path = mutantCopyPath(config, pr, copyId);
  assertCopyPath(config, pr.workspaceId, path);
  if (exists(path)) throw new Error(`${path} already exists`);

  // `-R` copies symlinks as symlinks rather than following them, on both BSD
  // and GNU cp. A failed attempt is removed before anything else is tried, or
  // the next `cp` would copy into it as a subfolder.
  const copyWith = async (flags: string[]) => {
    const result = await runCp(["cp", ...flags, source, path], { timeoutMs: COPY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      await rm(path, { recursive: true, force: true });
      throw new Error(`cp ${flags.join(" ")} failed: ${result.stderr.trim()}`);
    }
  };
  const headOf = async (dir: string) => (await git(gitRunner, ["rev-parse", "HEAD"], dir)).trim();

  let method: CopyMethod = "copy";
  try {
    if (platform === "darwin") {
      try {
        await copyWith(["-c", "-R"]);
        method = "clonefile";
      } catch (e) {
        console.log(
          `[mutation-testing] clonefile copy failed, falling back to a full copy: ${e instanceof Error ? e.message : String(e)}`,
        );
        await copyWith(["-R"]);
      }
    } else {
      console.log("[mutation-testing] no clonefile on this platform; making a full copy");
      await copyWith(["-R"]);
    }

    // Read through the copied `.git` file, which still names the review
    // worktree's git dir, before it is replaced.
    const [copyHead, sourceHead] = [await headOf(path), await headOf(source)];
    if (copyHead !== headSha || sourceHead !== headSha) {
      throw new Error("the checkout moved while it was being copied");
    }

    const unlinked = await removeOutwardLinks(path);
    if (unlinked.length > 0) {
      console.log(
        `[mutation-testing] removed ${unlinked.length} symlinks leading out of the copy: ${unlinked.slice(0, 5).join(", ")}`,
      );
    }
    for (const name of [".git", ...AGENT_FILES]) {
      await rm(join(path, name), { recursive: true, force: true });
    }
    await git(gitRunner, ["init", "-q"], path);
    await git(gitRunner, ["add", "-A"], path, COPY_TIMEOUT_MS);
    await git(
      gitRunner,
      [
        "-c",
        "user.name=Yarvis",
        "-c",
        "user.email=yarvis@localhost",
        "-c",
        "commit.gpgsign=false",
        "commit",
        "-q",
        "--no-verify",
        "--allow-empty",
        "-m",
        "Pull request as checked out for review",
      ],
      path,
      COPY_TIMEOUT_MS,
    );
  } catch (e) {
    await removeMutantCopy(config, pr.workspaceId, path).catch(() => {});
    throw e;
  }
  return { path, method };
}

/**
 * Deletes a mutant copy. Refuses anything but a mutant copy's own path, and a
 * symlink in its place is unlinked rather than followed.
 */
export async function removeMutantCopy(
  config: Pick<Config, "workspacesRoot">,
  workspaceId: string,
  path: string,
): Promise<void> {
  assertCopyPath(config, workspaceId, path);
  try {
    await rm(path, { recursive: true, force: true });
  } catch (first) {
    // The PR's tests and tooling can leave read-only folders behind (Go's
    // module cache, for one, is written read-only), which `rm` can't empty.
    await run(["chmod", "-R", "u+w", path]).catch(() => {});
    await rm(path, { recursive: true, force: true }).catch(() => {
      throw first;
    });
  }
}

/**
 * Removes the mutant copies no run is using any more: their run finished, or
 * no run was ever recorded for them and they are old enough that nobody is
 * still making one. Runs after interrupted runs are marked failed, so this
 * instance's own crashed runs count as finished; another instance's live runs
 * are still `running` and keep their copies. `inUse` names copies this process
 * is making right now.
 */
export async function sweepMutantCopies(
  db: Db,
  config: Pick<Config, "workspacesRoot">,
  inUse: ReadonlySet<string> = new Set(),
  now: number = Date.now(),
): Promise<number> {
  let workspaces: string[];
  try {
    workspaces = readdirSync(reviewWorkspacesRoot(config));
  } catch {
    return 0;
  }
  const candidates: { workspaceId: string; path: string; copyId: string }[] = [];
  for (const workspaceId of workspaces) {
    const dir = reviewWorkspaceDir(config, workspaceId);
    if (!isRealDirectory(dir)) continue;
    for (const name of readdirSync(dir)) {
      const match = COPY_NAME.exec(name);
      if (match?.[2]) candidates.push({ workspaceId, path: join(dir, name), copyId: match[2] });
    }
  }
  if (candidates.length === 0) return 0;

  const rows = await db
    .select({ copyId: sql<string>`${agentRuns.meta}->>'copyId'`, status: agentRuns.status })
    .from(agentRuns)
    .where(
      and(eq(agentRuns.kind, MUTATION_RUN_KIND), sql`${agentRuns.meta}->>'copyId' is not null`),
    );
  const statusByCopy = new Map(rows.map((row) => [row.copyId, row.status]));

  let removed = 0;
  for (const candidate of candidates) {
    if (inUse.has(candidate.copyId)) continue;
    const status = statusByCopy.get(candidate.copyId);
    if (status === "running") continue;
    if (status === undefined) {
      try {
        if (now - lstatSync(candidate.path).mtimeMs < ORPHAN_AGE_MS) continue;
      } catch {
        continue;
      }
    }
    try {
      await removeMutantCopy(config, candidate.workspaceId, candidate.path);
      removed++;
    } catch (e) {
      console.error(`[mutation-testing] could not remove ${candidate.path}:`, e);
    }
  }
  return removed;
}
