import type { Db } from "../db/client.ts";
import { listEvents } from "../events/service.ts";
import type { PrInvolvement } from "../pr/types.ts";
import type { GitHubClient, PrNumberRef } from "./client.ts";

/**
 * The "Reviewing" list: PRs the user has actually engaged with, as opposed to
 * ones merely requested of them. Two signals feed it —
 *
 * - the local `pr.viewed` event log, which records every PR opened in yarvis; and
 * - GitHub's own record of the user's comments and submitted reviews.
 *
 * The union is then split into work still owed (`inProgress`) and work that has
 * landed or been signed off (`complete`), so the UI can collapse the latter.
 */

export interface ReviewingList {
  inProgress: PrInvolvement[];
  complete: PrInvolvement[];
}

/**
 * Ceiling on how many viewed-but-not-otherwise-found PRs get refreshed from
 * GitHub. They all travel in one aliased GraphQL request, so this bounds that
 * request's size rather than a request count.
 */
const MAX_VIEWED_LOOKUPS = 40;

/** Upper bound on the event rows scanned for viewed PRs within the lookback. */
const MAX_VIEWED_EVENTS = 500;

function involvementKey(ref: PrNumberRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** GitHub search's `updated:` qualifier takes a bare date, not a timestamp. */
function toSearchDate(at: Date): string {
  return at.toISOString().slice(0, 10);
}

/**
 * Pulls the GitHub PR refs out of `pr.viewed` event payloads, preserving the
 * given order and dropping duplicates. Payloads are validated field by field
 * because the event log accepts any JSON object: a row written by an older build
 * (or by hand) may not carry a usable ref at all.
 *
 * Azure PRs are skipped — this list is GitHub-only, since the comment/review
 * half of it has no Azure DevOps equivalent wired up.
 */
export function viewedRefsFromEvents(rows: { payload: unknown }[]): PrNumberRef[] {
  const seen = new Set<string>();
  const refs: PrNumberRef[] = [];
  for (const row of rows) {
    const ref = (row.payload as { ref?: Record<string, unknown> } | null)?.ref;
    if (!ref || ref.provider !== "github") continue;
    const { owner, repo, number } = ref;
    if (typeof owner !== "string" || typeof repo !== "string" || typeof number !== "number") {
      continue;
    }
    const candidate = { owner, repo, number };
    const key = involvementKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    refs.push(candidate);
  }
  return refs;
}

/** The GitHub PRs viewed in yarvis since `since`, most recently viewed first. */
export async function listViewedGithubPrs(db: Db, since: Date): Promise<PrNumberRef[]> {
  return viewedRefsFromEvents(
    await listEvents(db, { type: "pr.viewed", since, limit: MAX_VIEWED_EVENTS }),
  );
}

/**
 * A review is done when the PR is out of the author's hands (merged or closed)
 * or when the viewer's most recent verdict was an approval. Ordering matters:
 * an approval followed by a change request means the viewer is back on the hook,
 * so only the latest verdict counts.
 */
export function isReviewComplete(item: PrInvolvement): boolean {
  if (item.merged || item.summary.state === "closed") return true;
  return item.myReviewStates.at(-1) === "approved";
}

function byUpdatedDesc(a: PrInvolvement, b: PrInvolvement): number {
  return new Date(b.summary.updatedAt).getTime() - new Date(a.summary.updatedAt).getTime() || 0;
}

/**
 * Splits the candidate PRs into the two halves the UI renders, newest-updated
 * first, dropping the viewer's own PRs. The searches already exclude those, but
 * the viewed-event refs don't — opening your own PR in yarvis records the same
 * `pr.viewed` event as opening anyone else's.
 */
export function partitionInvolvement(items: PrInvolvement[], viewerLogin: string): ReviewingList {
  const inProgress: PrInvolvement[] = [];
  const complete: PrInvolvement[] = [];
  for (const item of items) {
    if (item.summary.author === viewerLogin) continue;
    (isReviewComplete(item) ? complete : inProgress).push(item);
  }
  inProgress.sort(byUpdatedDesc);
  complete.sort(byUpdatedDesc);
  return { inProgress, complete };
}

export async function getReviewingList(
  db: Db,
  gh: GitHubClient,
  viewerLogin: string,
  lookbackDays: number,
  now: Date = new Date(),
): Promise<ReviewingList> {
  const since = new Date(now.getTime() - lookbackDays * 24 * 60 * 60 * 1000);
  const updatedSince = `updated:>=${toSearchDate(since)}`;

  // `-author:@me` keeps the user's own PRs out: those live on the "My PRs" tab,
  // and every comment they leave on their own PR would otherwise land here.
  const [commented, reviewed, viewedRefs] = await Promise.all([
    gh.searchInvolvement(`is:pr -author:@me commenter:@me ${updatedSince}`, viewerLogin),
    gh.searchInvolvement(`is:pr -author:@me reviewed-by:@me ${updatedSince}`, viewerLogin),
    listViewedGithubPrs(db, since),
  ]);

  const byKey = new Map<string, PrInvolvement>();
  for (const item of [...commented, ...reviewed]) {
    byKey.set(involvementKey(item.summary), item);
  }

  // Viewed-in-yarvis PRs the searches didn't already cover: the user looked but
  // hasn't said anything yet, which is exactly the in-progress case. Their event
  // payload is a snapshot from view time, so refresh them from GitHub instead.
  const missing = viewedRefs.filter((ref) => !byKey.has(involvementKey(ref)));
  if (missing.length > 0) {
    const fetched = await gh.lookupInvolvement(missing.slice(0, MAX_VIEWED_LOOKUPS), viewerLogin);
    for (const item of fetched) byKey.set(involvementKey(item.summary), item);
  }

  return partitionInvolvement([...byKey.values()], viewerLogin);
}
