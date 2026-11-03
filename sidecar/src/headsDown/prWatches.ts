import { and, eq, exists, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { headsDownPrWatches, repos, workspaceRepoPr, workspaceRepos } from "../db/schema.ts";

/**
 * PR merge watches: a pass names a PR it wants to hear about when it merges,
 * the workspace poller notices the merge on its usual read, and the loop wakes
 * for it instead of finding out whenever its sleep ends. Only the PRs a pass
 * asked about wake it, so a busy repo's other merges don't.
 */

export type WatchResult =
  | { ok: true }
  | { ok: false; alreadyMerged: true }
  | { ok: false; error: string };

/**
 * Watches one PR in a workspace. The PR has to be the one the poller caches
 * for one of the workspace's repos, since the poller's reads are what notice
 * the merge. `repo` is the repo's name as get_workspace_status shows it, or
 * its owner/name. Watching it again replaces the note and re-arms the watch.
 */
export async function watchPrMerge(
  db: Db,
  input: { workspaceId: string; repo: string; number: number; note?: string | null },
): Promise<WatchResult> {
  const [trackedPr] = await db
    .select({
      workspaceRepoId: workspaceRepos.id,
      repoStatus: workspaceRepos.status,
      prNumber: workspaceRepoPr.prNumber,
      prState: workspaceRepoPr.prState,
    })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .innerJoin(workspaceRepoPr, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .where(
      and(
        eq(workspaceRepos.workspaceId, input.workspaceId),
        or(
          eq(repos.name, input.repo),
          sql`lower(${repos.owner} || '/' || ${repos.repo}) = lower(${input.repo})`,
        ),
      ),
    )
    .limit(1);
  if (!trackedPr || trackedPr.prNumber !== input.number) {
    return {
      ok: false,
      error: `${input.repo}#${input.number} isn't the PR this workspace tracks for that repo. Check get_workspace_status for the workspace's PRs.`,
    };
  }
  if (trackedPr.prState === "merged") return { ok: false, alreadyMerged: true };
  // Neither would ever fire: a closed PR won't merge, and the poller stops
  // reading a repo whose worktree was removed.
  if (trackedPr.prState === "closed") {
    return { ok: false, error: `${input.repo}#${input.number} was closed without merging.` };
  }
  if (trackedPr.repoStatus === "removed") {
    return {
      ok: false,
      error: `${input.repo}'s worktree was removed from this workspace, so its PR is no longer polled.`,
    };
  }
  const note = input.note?.trim() || null;
  await db
    .insert(headsDownPrWatches)
    .values({ workspaceRepoId: trackedPr.workspaceRepoId, prNumber: input.number, note })
    .onConflictDoUpdate({
      target: [headsDownPrWatches.workspaceRepoId, headsDownPrWatches.prNumber],
      set: { note, mergedAt: null, deliveredAt: null },
    });
  return { ok: true };
}

/**
 * Records the merge on every watch whose PR the poller now caches as merged.
 * Returns how many it marked, so the poller wakes the loop only when one did.
 */
export async function markMergedWatches(db: Db, now = new Date()): Promise<number> {
  const watchedPrIsMerged = db
    .select({ workspaceRepoId: workspaceRepoPr.workspaceRepoId })
    .from(workspaceRepoPr)
    .where(
      and(
        eq(workspaceRepoPr.workspaceRepoId, headsDownPrWatches.workspaceRepoId),
        eq(workspaceRepoPr.prNumber, headsDownPrWatches.prNumber),
        eq(workspaceRepoPr.prState, "merged"),
      ),
    );
  const marked = await db
    .update(headsDownPrWatches)
    .set({ mergedAt: now })
    .where(and(isNull(headsDownPrWatches.mergedAt), exists(watchedPrIsMerged)))
    .returning({ id: headsDownPrWatches.id });
  return marked.length;
}

/** A merged watch a pass hasn't been told about yet. */
export interface MergedWatch {
  id: string;
  workspaceId: string;
  repo: string;
  prNumber: number;
  note: string | null;
  mergedAt: Date;
}

/** The merged watches no pass has been told about, oldest merge first. */
export async function undeliveredMergedWatches(db: Db): Promise<MergedWatch[]> {
  const rows = await db
    .select({
      id: headsDownPrWatches.id,
      workspaceId: workspaceRepos.workspaceId,
      owner: repos.owner,
      repo: repos.repo,
      prNumber: headsDownPrWatches.prNumber,
      note: headsDownPrWatches.note,
      mergedAt: headsDownPrWatches.mergedAt,
    })
    .from(headsDownPrWatches)
    .innerJoin(workspaceRepos, eq(headsDownPrWatches.workspaceRepoId, workspaceRepos.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(isNotNull(headsDownPrWatches.mergedAt), isNull(headsDownPrWatches.deliveredAt)))
    .orderBy(headsDownPrWatches.mergedAt);
  return rows.map(({ owner, repo, mergedAt, ...rest }) => ({
    ...rest,
    repo: `${owner}/${repo}`,
    // Never null here: the query only reads merged watches.
    mergedAt: mergedAt as Date,
  }));
}

/** Marks watches as told to a pass, so the next pass isn't told again. */
export async function markWatchesDelivered(db: Db, ids: string[], now = new Date()): Promise<void> {
  if (ids.length === 0) return;
  await db
    .update(headsDownPrWatches)
    .set({ deliveredAt: now })
    .where(inArray(headsDownPrWatches.id, ids));
}
