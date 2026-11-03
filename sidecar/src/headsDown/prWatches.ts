import { and, eq, inArray, isNotNull, isNull, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  headsDownPrWatches,
  repos,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";

/**
 * PR merge watches: a pass names a PR it wants to hear about when it merges,
 * the workspace poller notices the merge on its usual read, and the loop wakes
 * for it instead of finding out whenever its sleep ends. Only the PRs a pass
 * asked about wake it, so a busy repo's other merges don't.
 */

export type WatchResult =
  | { ok: true; watchId: string }
  | { ok: false; alreadyMerged: true }
  | { ok: false; error: string };

/**
 * Watches one PR in a workspace. The PR has to be the one the poller caches
 * for one of the workspace's repos, since the poller's reads are what notice
 * the merge. Watching it again replaces the note.
 */
export async function watchPrMerge(
  db: Db,
  input: { workspaceId: string; repo: string; number: number; note?: string | null },
): Promise<WatchResult> {
  const [owner, name] = input.repo.split("/");
  const [row] = await db
    .select({
      workspaceRepoId: workspaceRepos.id,
      prNumber: workspaceRepoPr.prNumber,
      prState: workspaceRepoPr.prState,
    })
    .from(workspaceRepos)
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .innerJoin(workspaceRepoPr, eq(workspaceRepoPr.workspaceRepoId, workspaceRepos.id))
    .where(
      and(
        eq(workspaceRepos.workspaceId, input.workspaceId),
        sql`lower(${repos.owner}) = lower(${owner ?? ""})`,
        sql`lower(${repos.repo}) = lower(${name ?? ""})`,
      ),
    )
    .limit(1);
  if (!row || row.prNumber !== input.number) {
    return {
      ok: false,
      error: `${input.repo}#${input.number} isn't the PR this workspace tracks for that repo. Check get_workspace_status for the workspace's PRs.`,
    };
  }
  if (row.prState === "merged") return { ok: false, alreadyMerged: true };
  const note = input.note?.trim() || null;
  const [watch] = await db
    .insert(headsDownPrWatches)
    .values({ workspaceRepoId: row.workspaceRepoId, prNumber: input.number, note })
    .onConflictDoUpdate({
      target: [headsDownPrWatches.workspaceRepoId, headsDownPrWatches.prNumber],
      set: { note, mergedAt: null, deliveredAt: null },
    })
    .returning({ id: headsDownPrWatches.id });
  return { ok: true, watchId: (watch as { id: string }).id };
}

/**
 * Records the merge on every watch whose PR the poller now caches as merged.
 * Returns how many it marked, so the poller wakes the loop only when one did.
 */
export async function markMergedWatches(db: Db, now = new Date()): Promise<number> {
  const merged = db
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
    .where(and(isNull(headsDownPrWatches.mergedAt), sql`exists (${merged})`))
    .returning({ id: headsDownPrWatches.id });
  return marked.length;
}

/** A merged watch a pass hasn't been told about yet. */
export interface MergedWatch {
  id: string;
  workspaceId: string;
  workspaceName: string;
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
      workspaceId: workspaces.id,
      workspaceName: workspaces.name,
      owner: repos.owner,
      repo: repos.repo,
      prNumber: headsDownPrWatches.prNumber,
      note: headsDownPrWatches.note,
      mergedAt: headsDownPrWatches.mergedAt,
    })
    .from(headsDownPrWatches)
    .innerJoin(workspaceRepos, eq(headsDownPrWatches.workspaceRepoId, workspaceRepos.id))
    .innerJoin(workspaces, eq(workspaceRepos.workspaceId, workspaces.id))
    .innerJoin(repos, eq(workspaceRepos.repoId, repos.id))
    .where(and(isNotNull(headsDownPrWatches.mergedAt), isNull(headsDownPrWatches.deliveredAt)))
    .orderBy(headsDownPrWatches.mergedAt);
  return rows.map(({ owner, repo, mergedAt, ...rest }) => ({
    ...rest,
    repo: `${owner}/${repo}`,
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
