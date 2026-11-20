/**
 * Review marks: the head commit the user was looking at when they last
 * reviewed a pull request, so a later look can ask what changed since.
 *
 * Marks come from three places. Yarvis records one whenever the user submits
 * a review or posts a line comment through it (with the head the page was
 * showing), and when they say "Mark reviewed here". The provider is also asked
 * for the viewer's own reviews and the commit each was made on, so a review
 * done on github.com or in Azure DevOps counts too. The latest of all of them,
 * by when it happened, is "the last review".
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { AzureDevOpsClient, isAllowedAzureOrgUrl, orgFromOrgUrl } from "../azure/client.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type PrReviewMark, prReviewMarks } from "../db/schema.ts";
import { createGitHubClient } from "../github/client.ts";
import { describeError } from "../llm/errors.ts";
import {
  COMMIT_SHA_PATTERN,
  type CommitsSince,
  type PrRef,
  refKey,
  type ViewerReview,
} from "./types.ts";

export type ReviewMarkSource = PrReviewMark["source"];

const sha = z.string().regex(COMMIT_SHA_PATTERN, "expected a full commit sha");

/**
 * The commits a review or comment request says the page was showing, so the
 * mark records what the reviewer actually looked at rather than whatever the
 * provider's head had moved to by the time the request landed. Spread into a
 * request schema; every field is optional, since an older client sends none.
 */
export const seenCommitFields = {
  headSha: sha.optional(),
  baseSha: sha.optional(),
  mergeBaseSha: sha.optional(),
};

export interface ReviewMarkInput {
  ref: PrRef;
  headSha: string;
  baseSha?: string | null;
  mergeBaseSha?: string | null;
  source: Exclude<ReviewMarkSource, "provider">;
}

/** The commits a review or comment request said it saw (see {@link seenCommitFields}). */
export interface SeenCommits {
  headSha?: string;
  baseSha?: string;
  mergeBaseSha?: string;
}

/** The sha a review route should record: what the page showed, else what the provider used. */
export function seenHead(claimed: string | undefined, fallback: string | null): string | null {
  if (claimed && COMMIT_SHA_PATTERN.test(claimed)) return claimed;
  return fallback && COMMIT_SHA_PATTERN.test(fallback) ? fallback : null;
}

/**
 * The mark a review or comment route records: at the head the page said it
 * was showing, else at `fallback` (the provider's commit for it). Null when
 * neither is a commit, so nothing is recorded.
 */
export function seenMarkInput(
  ref: PrRef,
  seen: SeenCommits,
  fallback: string | null,
  source: "review" | "comment",
): ReviewMarkInput | null {
  const headSha = seenHead(seen.headSha, fallback);
  if (!headSha) return null;
  // The page's base and merge-base belong to the head it sent, not to the provider's.
  const own = headSha === seen.headSha;
  return {
    ref,
    headSha,
    baseSha: own ? seen.baseSha : null,
    mergeBaseSha: own ? seen.mergeBaseSha : null,
    source,
  };
}

/** Records a mark. A sha that isn't one is refused rather than stored for git to choke on later. */
export async function recordReviewMark(db: Db, input: ReviewMarkInput): Promise<PrReviewMark> {
  for (const sha of [input.headSha, input.baseSha, input.mergeBaseSha]) {
    if (sha != null && !COMMIT_SHA_PATTERN.test(sha)) throw new Error("not a commit sha");
  }
  const [row] = await db
    .insert(prReviewMarks)
    .values({
      refKey: refKey(input.ref),
      headSha: input.headSha,
      baseSha: input.baseSha ?? null,
      mergeBaseSha: input.mergeBaseSha ?? null,
      source: input.source,
    })
    .returning();
  if (!row) throw new Error("failed to record review mark");
  return row;
}

export async function latestReviewMark(db: Db, ref: PrRef): Promise<PrReviewMark | null> {
  const [row] = await db
    .select()
    .from(prReviewMarks)
    .where(eq(prReviewMarks.refKey, refKey(ref)))
    .orderBy(desc(prReviewMarks.createdAt))
    .limit(1);
  return row ?? null;
}

/** Fills in a merge-base the mark was recorded without, once a checkout has worked it out. */
export async function setMarkMergeBase(db: Db, id: string, mergeBaseSha: string): Promise<void> {
  await db
    .update(prReviewMarks)
    .set({ mergeBaseSha })
    .where(and(eq(prReviewMarks.id, id), isNull(prReviewMarks.mergeBaseSha)));
}

/** The latest mark of `ref` at `headSha`, or null when no review of that commit is recorded. */
export async function findReviewMark(
  db: Db,
  ref: PrRef,
  headSha: string,
): Promise<PrReviewMark | null> {
  const [row] = await db
    .select()
    .from(prReviewMarks)
    .where(and(eq(prReviewMarks.refKey, refKey(ref)), eq(prReviewMarks.headSha, headSha)))
    .orderBy(desc(prReviewMarks.createdAt))
    .limit(1);
  return row ?? null;
}

/** The distinct commits of `ref`'s most recent marks, newest first: what a review clone keeps pinned. */
export async function recentMarkShas(db: Db, ref: PrRef, limit: number): Promise<string[]> {
  const rows = await db
    .select({ headSha: prReviewMarks.headSha })
    .from(prReviewMarks)
    .where(eq(prReviewMarks.refKey, refKey(ref)))
    .orderBy(desc(prReviewMarks.createdAt))
    .limit(limit * 4);
  return [...new Set(rows.map((r) => r.headSha))].slice(0, limit);
}

/**
 * Stores the viewer's provider-side reviews as `provider` marks, one per
 * commit, dated by the latest review of it. Idempotent: the partial unique
 * index turns a re-read of the same reviews into at most a later date.
 */
export async function storeProviderMarks(
  db: Db,
  ref: PrRef,
  reviews: ViewerReview[],
): Promise<void> {
  // One row per commit, the latest review's: a conflict update can't touch a row twice.
  const latest = new Map<string, ViewerReview>();
  for (const r of reviews) {
    if (!COMMIT_SHA_PATTERN.test(r.headSha) || Number.isNaN(Date.parse(r.submittedAt))) continue;
    const seen = latest.get(r.headSha);
    if (!seen || Date.parse(r.submittedAt) > Date.parse(seen.submittedAt)) latest.set(r.headSha, r);
  }
  const rows = [...latest.values()].map((r) => ({
    refKey: refKey(ref),
    headSha: r.headSha,
    mergeBaseSha: r.mergeBaseSha && COMMIT_SHA_PATTERN.test(r.mergeBaseSha) ? r.mergeBaseSha : null,
    source: "provider" as const,
    createdAt: new Date(r.submittedAt),
  }));
  if (rows.length === 0) return;
  await db
    .insert(prReviewMarks)
    .values(rows)
    .onConflictDoUpdate({
      target: [prReviewMarks.refKey, prReviewMarks.headSha],
      targetWhere: sql`${prReviewMarks.source} = 'provider'`,
      set: { createdAt: sql`greatest(${prReviewMarks.createdAt}, excluded.created_at)` },
    });
}

/** What the marks need from a provider; injectable so tests run without one. */
export interface ReviewMarkProvider {
  /** The viewer's submitted reviews and their commits. */
  viewerReviews(ref: PrRef): Promise<ViewerReview[]>;
  /** How far `head` has moved on from `sha`. */
  commitsSince(ref: PrRef, sha: string, head: string): Promise<CommitsSince>;
  /** The PR's current head, for a caller that didn't say which one it has. */
  headSha(ref: PrRef): Promise<string | null>;
}

/**
 * The real provider for `ref`, or null when that provider isn't configured —
 * marks recorded through Yarvis still work then, there is just nothing to
 * read back.
 */
export function reviewMarkProvider(config: Config, ref: PrRef): ReviewMarkProvider | null {
  if (ref.provider === "github") {
    const token = config.secrets.githubToken;
    if (!token) return null;
    const gh = createGitHubClient(config, token);
    const gref = (r: PrRef) => r as Extract<PrRef, { provider: "github" }>;
    return {
      viewerReviews: (r) => gh.viewerReviews(gref(r).owner, gref(r).repo, gref(r).number),
      commitsSince: (r, sha, head) => gh.commitsSince(gref(r).owner, gref(r).repo, sha, head),
      headSha: async (r) =>
        (await gh.prDetail(gref(r).owner, gref(r).repo, gref(r).number)).headSha || null,
    };
  }
  const { azureDevopsToken, azureDevopsOrgUrl } = config.secrets;
  if (!azureDevopsToken || !azureDevopsOrgUrl || !isAllowedAzureOrgUrl(azureDevopsOrgUrl)) {
    return null;
  }
  // A ref from another organization than the configured one has no client here.
  if (orgFromOrgUrl(azureDevopsOrgUrl) !== ref.org) return null;
  const az = new AzureDevOpsClient(azureDevopsToken, azureDevopsOrgUrl);
  const aref = (r: PrRef) => {
    const { project, repo, prId } = r as Extract<PrRef, { provider: "azure" }>;
    return { project, repo, prId };
  };
  return {
    viewerReviews: (r) => az.viewerVotes(aref(r)),
    commitsSince: (r, sha) => az.commitsSince(aref(r), sha),
    headSha: (r) => az.headSha(aref(r)),
  };
}

/** How long a provider read of the viewer's reviews stands before it is asked again. */
const PROVIDER_SYNC_TTL_MS = 60_000;

/** How long a failed provider read holds off the next try: short, but not every request. */
const PROVIDER_FAILURE_TTL_MS = 10_000;

/**
 * Reads the viewer's provider-side reviews into marks, at most once a minute
 * per pull request: every open of a PR asks for its last review, and both
 * providers rate-limit. A failure is logged and leaves the marks Yarvis has —
 * reading back is a refinement, not something to fail the request over — and
 * holds off for `failureTtlMs`, so a rate-limited provider isn't asked again
 * on every request.
 */
export function createProviderMarkSync(
  ttlMs = PROVIDER_SYNC_TTL_MS,
  failureTtlMs = PROVIDER_FAILURE_TTL_MS,
) {
  /** Ref key → when the next read may go to the provider. */
  const nextAt = new Map<string, number>();
  return {
    async sync(db: Db, ref: PrRef, provider: ReviewMarkProvider | null): Promise<void> {
      if (!provider) return;
      const key = refKey(ref);
      if (Date.now() < (nextAt.get(key) ?? 0)) return;
      nextAt.set(key, Date.now() + ttlMs);
      try {
        await storeProviderMarks(db, ref, await provider.viewerReviews(ref));
      } catch (e) {
        nextAt.set(key, Date.now() + failureTtlMs);
        console.warn(`[pr] could not read your reviews of ${key}:`, describeError(e));
      }
    },
    /** Forgets every read, so the next one asks the provider. For tests. */
    forget(): void {
      nextAt.clear();
    },
  };
}

/** The one throttle every route shares, so the classic page and a review workspace don't each ask. */
export const providerMarks = createProviderMarkSync();

/**
 * Memoizes a provider answer per key for `ttlMs` (a failure for
 * `failureTtlMs`), so a page polling the same question asks the provider at
 * most that often. A failure is remembered as `null`, already logged.
 */
export function createProviderThrottle<T>(
  ttlMs = PROVIDER_SYNC_TTL_MS,
  failureTtlMs = PROVIDER_FAILURE_TTL_MS,
) {
  const answers = new Map<string, { until: number; value: Promise<T | null> }>();
  return {
    get(key: string, ask: () => Promise<T>, context: string): Promise<T | null> {
      const now = Date.now();
      const held = answers.get(key);
      if (held && now < held.until) return held.value;
      for (const [k, a] of answers) if (a.until <= now) answers.delete(k);
      const entry: { until: number; value: Promise<T | null> } = {
        until: now + ttlMs,
        value: ask(),
      };
      entry.value = entry.value.catch((e): null => {
        entry.until = Date.now() + failureTtlMs;
        console.warn(`[pr] ${context}:`, describeError(e));
        return null;
      });
      answers.set(key, entry);
      return entry.value;
    },
    /** Forgets every answer. For tests. */
    forget(): void {
      answers.clear();
    },
  };
}

/** The classic page's "how far has the PR moved since your review", shared by every request. */
export const providerComparisons = createProviderThrottle<{
  headSha: string | null;
  since: CommitsSince | null;
}>();

/** The mark as the API shows it. */
export function toMarkResponse(mark: PrReviewMark) {
  return {
    headSha: mark.headSha,
    baseSha: mark.baseSha,
    mergeBaseSha: mark.mergeBaseSha,
    source: mark.source,
    createdAt: mark.createdAt.toISOString(),
  };
}

export type ReviewMarkResponse = ReturnType<typeof toMarkResponse>;
