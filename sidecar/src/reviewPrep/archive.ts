import { existsSync } from "node:fs";
import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import { raiseAttention, resolveRaisedAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  agentRuns,
  mutationRuns,
  type ReviewWorkspacePr,
  reviewPreps,
  reviewWorkspaces,
} from "../db/schema.ts";
import { createGitHubClient } from "../github/client.ts";
import { isReviewComplete } from "../github/reviewing.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { describeError } from "../llm/errors.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { CHECKOUT_WAIT_MS } from "../reviewWorkspaces/kickoff.ts";
import {
  archiveReviewWorkspace,
  assertWorktreeInWorkspace,
  listReviewWorkspaces,
  type ReviewDeps,
  reviewSessionFolder,
} from "../reviewWorkspaces/service.ts";
import { VERIFICATION_RUN_TIMEOUT_MS } from "../reviewWorkspaces/verification.ts";
import {
  defaultPrepDeps,
  enqueuePrep,
  inFlightPreps,
  isPrepInFlight,
  type ReviewPrepDeps,
} from "./service.ts";

/**
 * The upkeep review prep needs between passes:
 *
 * - Archives a review workspace review prep opened once every PR in it is
 *   approved by the user, merged or closed. Built-in archiving always asks;
 *   this is the one exception, and only for workspaces review prep opened. A
 *   workspace with uncommitted changes, or one where an Ask Claude session was
 *   started, is left alone and the user is asked instead.
 * - Resolves a prepared PR's attention item once its workspace is archived,
 *   by this job or by the user.
 * - Requeues a prep a restart left mid-way.
 */

export interface ReviewPrepUpkeepDeps {
  prep: ReviewPrepDeps;
  review: ReviewDeps;
  /**
   * Which of `refs` the user is done with, by refKey: merged, closed, or
   * approved by them last. A PR missing from the answer couldn't be read and
   * isn't done. Null when the provider can't be asked.
   */
  donePrs(refs: PrRef[]): Promise<Set<string> | null>;
  now?: () => Date;
}

/** Longer than a prep can run: its checkout wait and one run's timeout. */
const STALE_PREP_MS = CHECKOUT_WAIT_MS + VERIFICATION_RUN_TIMEOUT_MS;

/** A workspace the user opened this recently may be in use; it waits for the next run. */
const RECENTLY_OPENED_MS = 15 * 60 * 1000;

export const archiveAttentionKey = (workspaceId: string) => `review-prep-archive:${workspaceId}`;

export function defaultUpkeepDeps(db: Db, config: Config): ReviewPrepUpkeepDeps {
  const prep = defaultPrepDeps(db, config);
  return {
    prep,
    review: prep.kickoff.review,
    async donePrs(refs) {
      const token = config.secrets?.githubToken;
      if (!token) return null;
      const gh = createGitHubClient(config, token);
      const { login } = await gh.viewer();
      const github = refs.flatMap((r) => (r.provider === "github" ? [r] : []));
      const found = await gh.lookupInvolvement(github, login);
      return new Set(
        found.filter(isReviewComplete).map((item) =>
          refKey({
            provider: "github",
            owner: item.summary.owner,
            repo: item.summary.repo,
            number: item.summary.number,
          }),
        ),
      );
    },
  };
}

export interface UpkeepResult {
  requeued: number;
  archived: string[];
  /** Workspaces the user was asked about instead. */
  asked: string[];
  resolved: number;
}

export async function runReviewPrepUpkeep(
  db: Db,
  config: Config,
  deps: ReviewPrepUpkeepDeps,
): Promise<UpkeepResult> {
  const now = deps.now?.() ?? new Date();
  const requeued = await requeueStalled(db, config, deps, now);
  const { archived, asked } = await archiveDone(db, config, deps, now);
  const resolved = await resolveClosed(db);
  return { requeued, archived, asked, resolved };
}

async function requeueStalled(
  db: Db,
  config: Config,
  deps: ReviewPrepUpkeepDeps,
  now: Date,
): Promise<number> {
  let count = 0;
  for (const row of await inFlightPreps(db)) {
    if (isPrepInFlight(row.id)) continue;
    if (now.getTime() - row.updatedAt.getTime() < STALE_PREP_MS) continue;
    // Conditional on the row being as read, so two instances don't both take it.
    const [claimed] = await db
      .update(reviewPreps)
      .set({ state: "queued", updatedAt: now })
      .where(and(eq(reviewPreps.id, row.id), eq(reviewPreps.updatedAt, row.updatedAt)))
      .returning({ id: reviewPreps.id });
    if (!claimed) continue;
    enqueuePrep(db, config, row.id, deps.prep);
    count++;
  }
  return count;
}

async function archiveDone(
  db: Db,
  config: Config,
  deps: ReviewPrepUpkeepDeps,
  now: Date,
): Promise<{ archived: string[]; asked: string[] }> {
  const archived: string[] = [];
  const asked: string[] = [];
  const candidates = (await listReviewWorkspaces(db)).filter(
    (ws) =>
      ws.status === "active" &&
      ws.openedBy === "review-prep" &&
      ws.prs.length > 0 &&
      // Only GitHub says whether the user approved; an Azure PR is left to the user.
      ws.prs.every((pr) => pr.ref.provider === "github") &&
      !(ws.lastOpenedAt && now.getTime() - ws.lastOpenedAt.getTime() < RECENTLY_OPENED_MS),
  );
  if (candidates.length === 0) return { archived, asked };

  let done: Set<string> | null;
  try {
    done = await deps.donePrs(candidates.flatMap((ws) => ws.prs.map((pr) => pr.ref)));
  } catch (e) {
    console.error("[review-prep] could not read the PRs' state:", describeError(e));
    return { archived, asked };
  }
  if (!done) return { archived, asked };

  for (const ws of candidates) {
    if (!ws.prs.every((pr) => done.has(pr.refKey))) continue;
    try {
      const keys = ws.prs.map((pr) => pr.refKey);
      if (await hasRunningWork(db, keys)) continue;
      const reasons = await reasonsToAsk(config, ws.id, ws.prs, deps.review);
      const first = ws.prs[0] as ReviewWorkspacePr;
      if (reasons.length > 0) {
        await raiseAttention(db, {
          category: "review",
          kind: "action",
          title: "Review workspace ready to archive",
          body: `${ws.name}: every PR in it is approved, merged or closed, but ${reasons.join(" and ")}. Archive it from the Review tab when you're done with it.`,
          dedupeKey: archiveAttentionKey(ws.id),
          navTarget: { type: "review-workspace", workspaceId: ws.id, prId: first.id },
        });
        asked.push(ws.id);
        continue;
      }
      await archiveReviewWorkspace(db, config, ws.id, deps.review);
      await resolveRaisedAttention(db, archiveAttentionKey(ws.id));
      archived.push(ws.id);
    } catch (e) {
      console.error(`[review-prep] could not archive review workspace ${ws.id}:`, describeError(e));
    }
  }
  return { archived, asked };
}

/** A verification or mutation-testing run still going on one of the PRs; the next run tries again. */
async function hasRunningWork(db: Db, keys: string[]): Promise<boolean> {
  const preps = await db
    .select({ id: reviewPreps.id })
    .from(reviewPreps)
    .where(
      and(inArray(reviewPreps.refKey, keys), inArray(reviewPreps.state, ["queued", "verifying"])),
    )
    .limit(1);
  if (preps.length > 0) return true;
  const runs = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.status, "running"),
        inArray(sql<string>`${agentRuns.meta}->>'refKey'`, keys),
      ),
    )
    .limit(1);
  if (runs.length > 0) return true;
  const mutations = await db
    .select({ id: mutationRuns.id })
    .from(mutationRuns)
    .where(and(eq(mutationRuns.status, "running"), inArray(mutationRuns.refKey, keys)))
    .limit(1);
  return mutations.length > 0;
}

/**
 * Why the user should archive it themselves. The sidecar can't ask the core
 * whether an Ask Claude session is still running, so a session folder left
 * from any start counts as one.
 */
async function reasonsToAsk(
  config: Config,
  workspaceId: string,
  prs: Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">[],
  review: ReviewDeps,
): Promise<string[]> {
  const reasons: string[] = [];
  if (existsSync(reviewSessionFolder(config, workspaceId))) {
    reasons.push("an Ask Claude session was started in it");
  }
  for (const pr of prs) {
    if (await hasUncommittedChanges(config, pr, review)) {
      reasons.push("a checkout has uncommitted changes");
      break;
    }
  }
  return reasons;
}

/** A checkout that can't be checked counts as changed, so nothing is removed on a guess. */
async function hasUncommittedChanges(
  config: Config,
  pr: Pick<ReviewWorkspacePr, "workspaceId" | "worktreePath">,
  review: ReviewDeps,
): Promise<boolean> {
  if (!existsSync(pr.worktreePath)) return false;
  try {
    assertWorktreeInWorkspace(config, pr);
    const result = await review
      .git({})
      .local(["status", "--porcelain", "--ignore-submodules=all"], { cwd: pr.worktreePath });
    return result.exitCode !== 0 || result.stdout.trim() !== "";
  } catch (e) {
    console.error("[review-prep] could not check a checkout for changes:", describeError(e));
    return true;
  }
}

/**
 * Resolves the items of preps whose workspace is gone, and any ask to archive
 * it, and marks the preps done.
 */
async function resolveClosed(db: Db): Promise<number> {
  const rows = await db
    .select({
      id: reviewPreps.id,
      attentionKey: reviewPreps.attentionKey,
      workspaceId: reviewPreps.workspaceId,
    })
    .from(reviewPreps)
    .leftJoin(reviewWorkspaces, eq(reviewWorkspaces.id, reviewPreps.workspaceId))
    .where(
      and(
        ne(reviewPreps.state, "done"),
        notInFlight(),
        or(isNull(reviewPreps.workspaceId), eq(reviewWorkspaces.status, "archived")),
      ),
    );
  for (const row of rows) {
    await resolveRaisedAttention(db, row.attentionKey);
    if (row.workspaceId) await resolveRaisedAttention(db, archiveAttentionKey(row.workspaceId));
    await db
      .update(reviewPreps)
      .set({ state: "done", updatedAt: new Date() })
      .where(eq(reviewPreps.id, row.id));
  }
  return rows.length;
}

function notInFlight() {
  return and(ne(reviewPreps.state, "queued"), ne(reviewPreps.state, "verifying"));
}

export const reviewPrepJob: JobDefinition = {
  name: "review-prep",
  description:
    "Every 15 minutes, archive the review workspaces review prep opened once you're done with their PRs, and pick up a prep a restart interrupted.",
  schedule: { kind: "interval", everyMs: 15 * 60 * 1000 },
  run: async ({ db, config }) => {
    const result = await runReviewPrepUpkeep(db, config, defaultUpkeepDeps(db, config));
    const changed =
      result.requeued + result.archived.length + result.asked.length + result.resolved;
    return {
      skipped: changed === 0,
      detail: `archived ${result.archived.length}, asked about ${result.asked.length}, resolved ${result.resolved}, requeued ${result.requeued}`,
    };
  },
};
