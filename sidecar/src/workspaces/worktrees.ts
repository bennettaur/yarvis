/**
 * Every worktree of a workspace repo's clone that sits inside the workspace
 * folder: the one provisioning cut, and any an agent added beside it.
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
import { relative, sep } from "node:path";
import { and, eq, ne } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type Repo, repos, type WorkspaceRepo, workspaceRepos, workspaces } from "../db/schema.ts";
import { redactSecrets } from "../llm/errors.ts";
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
 * A worktree root inside a `.git` directory would let the editor routes reach
 * that repo's config and hooks, which `resolveInWorktree` only refuses below
 * the root. The listing comes from `.git/worktrees/*` in the clone, which an
 * agent can write, so it is not trusted to have ruled this out.
 */
function underGitDir(path: string, root: string): boolean {
  return relative(root, path)
    .split(sep)
    .some((segment) => segment.toLowerCase() === ".git");
}

/**
 * The repo's worktrees inside `workspaceRoot`, primary first.
 *
 * A worktree whose folder is gone is left out: git keeps listing it until the
 * next prune, but it has nothing left to show. A discovered worktree's path is
 * the canonical one its containment was checked on, so a folder swapped for a
 * symlink afterwards doesn't move where the caller ends up.
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

  const canonical = entries.map((entry) => ({ ...entry, path: canonicalPath(entry.path) }));
  const primaryEntry = canonical.find((entry) => entry.path === primaryPath);
  const found: WorkspaceWorktree[] = [
    {
      path: wr.worktreePath,
      // Not `?.branch ?? wr.branch`: a null branch here is a detached HEAD,
      // which is worth showing, not a missing entry.
      branch: primaryEntry ? primaryEntry.branch : wr.branch,
      primary: true,
    },
  ];
  for (const entry of canonical) {
    if (entry.path === primaryPath || !isInside(entry.path, root)) continue;
    if (underGitDir(entry.path, root) || !existsSync(entry.path)) continue;
    found.push({ path: entry.path, branch: entry.branch, primary: false });
  }
  return found;
}

const primaryOnly = (wr: WorkspaceRepo): WorkspaceWorktree[] => [
  { path: wr.worktreePath, branch: wr.branch, primary: true },
];

const errorText = (e: unknown): string => redactSecrets(e instanceof Error ? e.message : String(e));

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
 * With no `requested` path this is the primary worktree, returned even when the
 * clone can't be listed, so the default views don't depend on `git worktree
 * list` succeeding. A requested path must match a discovered worktree; the path
 * returned is git's, not the caller's.
 *
 * A torn-down repo or an archived workspace doesn't resolve: an archived
 * workspace's folder name can be reused by a new one, and its stale repo id
 * must not reach the new workspace's worktrees. A repo whose setup failed still
 * does, since "Ignore and use anyway" leaves it in `error` with a usable
 * worktree.
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
    .where(
      and(
        eq(workspaceRepos.id, workspaceRepoId),
        ne(workspaceRepos.status, "removed"),
        ne(workspaces.status, "archived"),
      ),
    );
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
  const match = target
    ? all.find((w) => canonicalPath(w.path) === target)
    : all.find((w) => w.primary);
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
