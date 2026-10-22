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
 * reverts it. A copied worktree's `.git` would otherwise point at the review
 * clone, and sharing that worktree's index and HEAD is the review checkout.
 *
 * Copies are removed when their run ends, however it ends; the startup sweep
 * removes what a crashed sidecar left.
 */

import { lstatSync, readdirSync } from "node:fs";
import { rm } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns, type ReviewWorkspacePr } from "../db/schema.ts";
import { type RunResult, run } from "../workspaces/exec.ts";
import { type GitRunner, git } from "../workspaces/git.ts";
import { reviewGit } from "./git.ts";

/** The run kind mutation tests are stored under. */
export const MUTATION_RUN_KIND = "mutation";

const COPY_NAME = /^(.+)-mutants-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

/** Copying a large tree without clonefile, or committing it, can take a while. */
const COPY_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A copy with no run row yet may be one another instance is still making;
 * past this age it is a leftover.
 */
const ORPHAN_AGE_MS = 60 * 60 * 1000;

export type CopyMethod = "clonefile" | "copy";

export interface MutantCopy {
  path: string;
  method: CopyMethod;
}

export interface MutantCopyDeps {
  /** Runs `cp`; injectable so tests can make clonefile fail. */
  run?: (args: string[], opts: { timeoutMs?: number }) => Promise<RunResult>;
  git?: GitRunner;
  platform?: NodeJS.Platform;
}

/** The folder holding one review workspace's worktrees and their mutant copies. */
function workspaceDir(config: Pick<Config, "workspacesRoot">, workspaceId: string): string {
  return join(config.workspacesRoot, ".review", workspaceId);
}

export function mutantCopyPath(
  config: Pick<Config, "workspacesRoot">,
  pr: Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">,
  copyId: string,
): string {
  return join(
    workspaceDir(config, pr.workspaceId),
    `${basename(pr.worktreePath)}-mutants-${copyId}`,
  );
}

/**
 * Throws unless `path` is a mutant copy's path directly in its workspace's
 * folder. Checked before anything is copied to or deleted from it.
 */
function assertCopyPath(config: Pick<Config, "workspacesRoot">, workspaceId: string, path: string) {
  const resolved = resolve(path);
  if (dirname(resolved) !== resolve(workspaceDir(config, workspaceId))) {
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
 * Copies the PR's worktree, including whatever its setup installed, and turns
 * the copy into a standalone repository. Removes a half-made copy on failure.
 */
export async function createMutantCopy(
  config: Pick<Config, "workspacesRoot">,
  pr: Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">,
  copyId: string,
  deps: MutantCopyDeps = {},
): Promise<MutantCopy> {
  const runCp = deps.run ?? run;
  const gitRunner = deps.git ?? reviewGit().local;
  const platform = deps.platform ?? process.platform;

  const source = resolve(pr.worktreePath);
  if (dirname(source) !== resolve(workspaceDir(config, pr.workspaceId))) {
    throw new Error(`${pr.worktreePath} is not in this review workspace's folder`);
  }
  if (!isRealDirectory(source)) throw new Error(`no checkout at ${pr.worktreePath}`);
  const path = mutantCopyPath(config, pr, copyId);
  assertCopyPath(config, pr.workspaceId, path);
  if (exists(path)) throw new Error(`${path} already exists`);

  // `-R` copies symlinks as symlinks rather than following them, on both BSD
  // and GNU cp, so a link in the checkout can't pull the rest of the disk in.
  const copyWith = async (flags: string[]) => {
    const result = await runCp(["cp", ...flags, source, path], { timeoutMs: COPY_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      await rm(path, { recursive: true, force: true });
      throw new Error(`cp ${flags.join(" ")} failed: ${result.stderr.trim()}`);
    }
  };

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

    // The worktree's `.git` is a file naming the review clone's git dir.
    await rm(join(path, ".git"), { recursive: true, force: true });
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
    // Tests can leave read-only folders behind, which `rm` can't empty.
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
  const reviewRoot = join(config.workspacesRoot, ".review");
  let workspaces: string[];
  try {
    workspaces = readdirSync(reviewRoot);
  } catch {
    return 0;
  }
  const candidates: { workspaceId: string; path: string; copyId: string }[] = [];
  for (const workspaceId of workspaces) {
    const dir = join(reviewRoot, workspaceId);
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
