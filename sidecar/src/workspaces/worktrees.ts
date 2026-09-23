/**
 * The worktrees a workspace repo has beyond the one provisioning cut.
 *
 * An agent building a stack of pull requests usually gives each branch its own
 * worktree, and the branch the workspace started on is not always a layer of
 * that stack. So the views that read a worktree — files, changes, the stack —
 * can be pointed at any worktree of the repo's clone that sits inside the
 * workspace folder, not only the one the workspace row records.
 *
 * A worktree a client names is only ever matched against a fresh listing, never
 * used as given: the path decides where git runs and where a file is written,
 * so it has to be one git itself reports for this repo, inside this workspace.
 */

import { existsSync } from "node:fs";
import { sep } from "node:path";
import { and, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Repo, repos, type WorkspaceRepo, workspaceRepos, workspaces } from "../db/schema.ts";
import { canonicalPath, type GitRunner, listWorktrees, nearestBaseRef } from "./git.ts";

export interface WorkspaceWorktree {
  path: string;
  /** The branch checked out there, or null on a detached HEAD. */
  branch: string | null;
  /** True for the worktree provisioning created, which the workspace row names. */
  primary: boolean;
}

export interface WorkspaceRepoWorktrees {
  workspaceRepoId: string;
  worktrees: WorkspaceWorktree[];
  /** Why only the primary worktree is listed, when git couldn't be asked. */
  error: string | null;
}

function isInside(path: string, root: string): boolean {
  return path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/**
 * The repo's worktrees inside `workspaceRoot`, primary first.
 *
 * A worktree whose folder is gone is left out: git keeps listing it until the
 * next prune, but it has nothing left to show.
 */
async function discoverWorktrees(
  runner: GitRunner,
  workspaceRoot: string,
  wr: WorkspaceRepo,
  repo: Repo,
): Promise<WorkspaceWorktree[]> {
  const root = canonicalPath(workspaceRoot);
  const primaryPath = canonicalPath(wr.worktreePath);
  const entries = await listWorktrees(runner, repo.primaryClonePath);

  const primaryEntry = entries.find((entry) => canonicalPath(entry.path) === primaryPath);
  const found: WorkspaceWorktree[] = [
    {
      path: wr.worktreePath,
      branch: primaryEntry ? primaryEntry.branch : wr.branch,
      primary: true,
    },
  ];
  for (const entry of entries) {
    const path = canonicalPath(entry.path);
    if (path === primaryPath || !isInside(path, root) || !existsSync(entry.path)) continue;
    found.push({ path: entry.path, branch: entry.branch, primary: false });
  }
  return found;
}

const primaryOnly = (wr: WorkspaceRepo): WorkspaceWorktree[] => [
  { path: wr.worktreePath, branch: wr.branch, primary: true },
];

const errorText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/**
 * Every ready repo's worktrees in one workspace, for the right column's picker.
 * One repo's clone failing to answer lists that repo's primary worktree alone
 * rather than failing the rest.
 */
export async function listWorkspaceWorktrees(
  db: Db,
  workspaceId: string,
  runner: GitRunner,
): Promise<WorkspaceRepoWorktrees[]> {
  const rows = await db
    .select({ wr: workspaceRepos, repo: repos, rootPath: workspaces.rootPath })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .where(and(eq(workspaceRepos.workspaceId, workspaceId), eq(workspaceRepos.status, "ready")))
    .orderBy(workspaceRepos.createdAt);

  return Promise.all(
    rows.map(async ({ wr, repo, rootPath }) => {
      try {
        const worktrees = await discoverWorktrees(runner, rootPath, wr, repo);
        return { workspaceRepoId: wr.id, worktrees, error: null };
      } catch (e) {
        return { workspaceRepoId: wr.id, worktrees: primaryOnly(wr), error: errorText(e) };
      }
    }),
  );
}

/** A worktree a request asked for, checked against what git reports. */
export interface ResolvedWorktree {
  workspaceRepo: WorkspaceRepo;
  repo: Repo;
  path: string;
  branch: string | null;
  primary: boolean;
  /** Every worktree of the repo in this workspace, this one included. */
  all: WorkspaceWorktree[];
}

/**
 * Resolves which worktree of a workspace repo a request means.
 *
 * With no `requested` path this is the primary worktree, and a clone that can't
 * be listed still answers with it so the views that worked before discovery
 * existed keep working. A requested path must match a discovered worktree; the
 * path returned is git's, not the caller's.
 */
export async function resolveWorktree(
  db: Db,
  workspaceRepoId: string,
  requested: string | undefined,
  runner: GitRunner,
): Promise<ResolvedWorktree> {
  const [row] = await db
    .select({ wr: workspaceRepos, repo: repos, rootPath: workspaces.rootPath })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .where(eq(workspaceRepos.id, workspaceRepoId));
  if (!row) throw new Error("workspace repo not found");
  const { wr, repo, rootPath } = row;

  let all: WorkspaceWorktree[];
  try {
    all = await discoverWorktrees(runner, rootPath, wr, repo);
  } catch (e) {
    if (requested) throw e;
    all = primaryOnly(wr);
  }

  const target = requested ? canonicalPath(requested) : null;
  const match = target ? all.find((w) => canonicalPath(w.path) === target) : all[0];
  if (!match) throw new Error("worktree not found in this workspace");
  return { workspaceRepo: wr, repo, ...match, all };
}

/**
 * The ref a worktree's changes are measured from: the branch of another
 * worktree in this workspace it is stacked on, or the repo's base branch.
 */
export function worktreeDiffBase(runner: GitRunner, worktree: ResolvedWorktree): Promise<string> {
  const candidates = worktree.all
    .filter((w) => w.path !== worktree.path && w.branch && w.branch !== worktree.branch)
    .map((w) => `refs/heads/${w.branch}`);
  return nearestBaseRef(
    runner,
    worktree.path,
    `origin/${worktree.workspaceRepo.baseBranch}`,
    candidates,
  );
}
