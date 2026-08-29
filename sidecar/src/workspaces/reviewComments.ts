/**
 * Self-review comments on a workspace's own diffs.
 *
 * These are local notes a reviewer leaves on their own changed lines before the
 * work is published, so the feedback never lands on a PR for other people to
 * read and go stale. Every comment is scoped to a workspace repo, and the
 * workspace is the unit both the list and the teardown work in — a comment
 * outlives neither its repo (FK cascade) nor its workspace's archival.
 */

import { and, asc, eq, inArray } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type WorkspaceReviewComment,
  workspaceRepos,
  workspaceReviewComments,
} from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";
import { defaultGitRunner, type GitRunner, headCommit } from "./git.ts";

export interface CreateReviewCommentInput {
  workspaceRepoId: string;
  path: string;
  startLine: number;
  endLine: number;
  body: string;
}

export interface UpdateReviewCommentInput {
  resolved: boolean;
}

/** The workspace repo ids belonging to a workspace, for scoping every query. */
async function repoIdsForWorkspace(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ id: workspaceRepos.id })
    .from(workspaceRepos)
    .where(eq(workspaceRepos.workspaceId, workspaceId));
  return rows.map((r) => r.id);
}

/**
 * Every review comment in a workspace, oldest first. Ordering by creation
 * rather than by file keeps the list in the order the reviewer wrote it, which
 * is the order the collected text reads best in.
 */
export async function listReviewComments(
  db: Db,
  workspaceId: string,
): Promise<WorkspaceReviewComment[]> {
  const repoIds = await repoIdsForWorkspace(db, workspaceId);
  if (repoIds.length === 0) return [];
  return db
    .select()
    .from(workspaceReviewComments)
    .where(inArray(workspaceReviewComments.workspaceRepoId, repoIds))
    .orderBy(asc(workspaceReviewComments.createdAt));
}

/**
 * Records a comment against a file's line range and the worktree's current
 * HEAD. Returns null when the repo isn't part of this workspace, so a caller
 * can't reach another workspace's worktree by guessing an id. The range is
 * taken as given — the route schema is what rejects a backwards one, so there
 * is one answer to that input rather than two.
 */
export async function createReviewComment(
  db: Db,
  workspaceId: string,
  input: CreateReviewCommentInput,
  runner: GitRunner = defaultGitRunner,
): Promise<WorkspaceReviewComment | null> {
  const [wr] = await db
    .select()
    .from(workspaceRepos)
    .where(
      and(
        eq(workspaceRepos.id, input.workspaceRepoId),
        eq(workspaceRepos.workspaceId, workspaceId),
      ),
    );
  if (!wr) return null;

  // A worktree that has been torn down, or a git that fails for any other
  // reason, shouldn't cost the reviewer their note — the sha is provenance, not
  // a requirement.
  const commitSha = await headCommit(runner, wr.worktreePath).catch(() => null);

  const [row] = await db
    .insert(workspaceReviewComments)
    .values({
      workspaceRepoId: wr.id,
      path: input.path,
      startLine: input.startLine,
      endLine: input.endLine,
      commitSha,
      body: input.body,
    })
    .returning();
  if (row) {
    // The body is the reviewer's own words about their in-flight work, so unlike
    // a session instruction it is safe to keep — it is what makes "what was I
    // worried about in this workspace" answerable later.
    void emitEvent(db, {
      type: "workspace.comment_added",
      source: "workspaces",
      payload: { workspaceId, path: input.path, body: input.body },
    });
  }
  return row ?? null;
}

/** Marks a comment resolved or reopens it. Null if it isn't this workspace's
 *  comment. */
export async function updateReviewComment(
  db: Db,
  workspaceId: string,
  commentId: string,
  patch: UpdateReviewCommentInput,
): Promise<WorkspaceReviewComment | null> {
  const repoIds = await repoIdsForWorkspace(db, workspaceId);
  if (repoIds.length === 0) return null;
  const [row] = await db
    .update(workspaceReviewComments)
    .set({ resolvedAt: patch.resolved ? new Date() : null, updatedAt: new Date() })
    .where(
      and(
        eq(workspaceReviewComments.id, commentId),
        inArray(workspaceReviewComments.workspaceRepoId, repoIds),
      ),
    )
    .returning();
  return row ?? null;
}

/** Deletes one comment. False if it isn't this workspace's comment. */
export async function deleteReviewComment(
  db: Db,
  workspaceId: string,
  commentId: string,
): Promise<boolean> {
  const repoIds = await repoIdsForWorkspace(db, workspaceId);
  if (repoIds.length === 0) return false;
  const rows = await db
    .delete(workspaceReviewComments)
    .where(
      and(
        eq(workspaceReviewComments.id, commentId),
        inArray(workspaceReviewComments.workspaceRepoId, repoIds),
      ),
    )
    .returning({ id: workspaceReviewComments.id });
  return rows.length > 0;
}

/**
 * Drops every review comment in a workspace. Called when the workspace is
 * archived: the notes were scaffolding for work that is now finished, and the
 * worktree they point into is gone.
 */
export async function deleteWorkspaceReviewComments(db: Db, workspaceId: string): Promise<void> {
  const repoIds = await repoIdsForWorkspace(db, workspaceId);
  if (repoIds.length === 0) return;
  await db
    .delete(workspaceReviewComments)
    .where(inArray(workspaceReviewComments.workspaceRepoId, repoIds));
}
