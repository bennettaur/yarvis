import { and, desc, eq, isNull, ne, or, sql } from "drizzle-orm";
import { raiseAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  agentRuns,
  type PrReviewMark,
  prUpdateWatches,
  type ReviewWorkspacePr,
} from "../db/schema.ts";
import { createGitHubClient, POLL_BATCH_SIZE } from "../github/client.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { describeError } from "../llm/errors.ts";
import { prSourceFor } from "../pr/source.ts";
import { type PrDetail, type PrRef, refKey } from "../pr/types.ts";
import type { KickoffDeps } from "../reviewWorkspaces/kickoff.ts";
import { shortPrName } from "../reviewWorkspaces/kickoff.ts";
import { whenIdle } from "../reviewWorkspaces/progress.ts";
import { type VerifyOutcome, verifyAndWait } from "../reviewWorkspaces/queue.ts";
import {
  defaultRereviewDeps,
  type ProviderIdentity,
  sameIdentity,
} from "../reviewWorkspaces/rereview.ts";
import { latestMark, reviewSinceReview } from "../reviewWorkspaces/reviewMarks.ts";
import {
  getReviewPr,
  listReviewWorkspaces,
  type ReviewDeps,
  ReviewWorkspaceError,
  type ReviewWorkspacePrSummary,
  refreshReviewPr,
} from "../reviewWorkspaces/service.ts";
import {
  type ReportSection,
  runSections,
  VERIFICATION_RUN_KIND,
} from "../reviewWorkspaces/verification.ts";
import type { ReviewPrepConfig } from "./config.ts";
import { defaultPrepDeps, withVerificationSlot } from "./service.ts";

/**
 * Re-review alerts: when a PR the user reviewed gets new commits, and it sits
 * in an active review workspace, this fetches them into the workspace, works
 * out what changed and which of the user's threads the new commits touch,
 * re-runs the verification checks the PR already had, and then raises one
 * "PR updated" item that opens the Since last review tab.
 *
 * "Reviewed" means the PR has a review mark: a review or line comment the user
 * posted (through Yarvis or on the provider), or "Mark reviewed here". A push
 * is acted on only once the head has stayed put for `SETTLE_MS`, so a burst of
 * pushes gives one alert. A merged or closed PR is left alone; the review-prep
 * job archives what it opened.
 */

/** How long a head must stay the same before it is acted on. */
export const SETTLE_MS = 10 * 60 * 1000;

/** The longest it waits for a refresh to move the checkout. */
const REFRESH_WAIT_MS = 10 * 60 * 1000;

export const prUpdatedAttentionKey = (key: string) => `pr-updated:${key}`;

export interface ProviderHead {
  open: boolean;
  headSha: string | null;
}

export interface PrUpdateDeps {
  review: ReviewDeps;
  kickoff: KickoffDeps;
  /** The provider's state and head for each ref, by refKey. A ref missing from the answer couldn't be read. */
  providerHeads(refs: PrRef[]): Promise<Map<string, ProviderHead>>;
  /** The PR's review threads, and who the user is there, to tell their threads apart. */
  loadDetail(ref: PrRef): Promise<Pick<PrDetail, "reviewThreads">>;
  viewer(ref: PrRef): Promise<ProviderIdentity>;
  prepConfig?: () => Promise<ReviewPrepConfig>;
  now?: () => Date;
  settleMs?: number;
  refreshWaitMs?: number;
}

export function defaultPrUpdateDeps(db: Db, config: Config): PrUpdateDeps {
  const prep = defaultPrepDeps(db, config);
  const rereview = defaultRereviewDeps(config);
  return {
    review: prep.kickoff.review,
    kickoff: prep.kickoff,
    providerHeads: (refs) => providerHeads(config, refs),
    loadDetail: rereview.loadDetail,
    viewer: rereview.viewer,
  };
}

/** GitHub refs go in batched status queries; an Azure PR is read one at a time. */
async function providerHeads(config: Config, refs: PrRef[]): Promise<Map<string, ProviderHead>> {
  const heads = new Map<string, ProviderHead>();
  const github = refs.flatMap((r) => (r.provider === "github" ? [r] : []));
  const token = config.secrets?.githubToken;
  if (github.length > 0 && token) {
    const gh = createGitHubClient(config, token);
    for (let i = 0; i < github.length; i += POLL_BATCH_SIZE) {
      const batch = github.slice(i, i + POLL_BATCH_SIZE);
      const results = await gh.prStatusesByNumber(batch);
      results.forEach((result, j) => {
        const ref = batch[j] as PrRef;
        if (!result.ok) return;
        const { status } = result.value;
        heads.set(refKey(ref), {
          open: status.state.toLowerCase() === "open" && !status.merged,
          headSha: status.headSha,
        });
      });
    }
  }
  for (const ref of refs) {
    if (ref.provider !== "azure") continue;
    try {
      const source = prSourceFor(config, ref);
      if ("error" in source) continue;
      const detail = await source.detail();
      heads.set(refKey(ref), {
        open: detail.state === "active" || detail.state === "open",
        headSha: detail.headSha || null,
      });
    } catch (e) {
      console.warn(`[pr-updates] could not read ${refKey(ref)}:`, describeError(e));
    }
  }
  return heads;
}

const background = new Set<Promise<void>>();

/** Resolves once every alert this process started has been raised or failed. For tests. */
export async function prUpdatesSettled(): Promise<void> {
  while (background.size > 0) await Promise.allSettled([...background]);
}

interface Watched {
  pr: ReviewWorkspacePrSummary;
  mark: PrReviewMark;
}

export interface PrUpdateResult {
  /** PRs whose new head is being prepared for an alert. */
  started: string[];
  /** PRs with a new head still inside the settle time. */
  settling: number;
}

export async function runPrUpdateWatch(
  db: Db,
  config: Config,
  deps: PrUpdateDeps,
): Promise<PrUpdateResult> {
  const now = deps.now?.() ?? new Date();
  const settleMs = deps.settleMs ?? SETTLE_MS;
  const watched = await reviewedPrs(db, deps);
  const result: PrUpdateResult = { started: [], settling: 0 };
  if (watched.length === 0) return result;

  let heads: Map<string, ProviderHead>;
  try {
    heads = await deps.providerHeads(watched.map((w) => w.pr.ref));
  } catch (e) {
    console.error("[pr-updates] could not read the PRs' heads:", describeError(e));
    return result;
  }

  for (const { pr, mark } of watched) {
    const head = heads.get(pr.refKey);
    if (!head?.open || !head.headSha || head.headSha === mark.headSha) continue;
    const [watch] = await db
      .select()
      .from(prUpdateWatches)
      .where(eq(prUpdateWatches.refKey, pr.refKey));
    if (watch?.alertedHeadSha === head.headSha) continue;
    if (watch?.seenHeadSha !== head.headSha) {
      await db
        .insert(prUpdateWatches)
        .values({ refKey: pr.refKey, seenHeadSha: head.headSha, seenAt: now })
        .onConflictDoUpdate({
          target: prUpdateWatches.refKey,
          set: { seenHeadSha: head.headSha, seenAt: now },
        });
      result.settling++;
      continue;
    }
    if (now.getTime() - watch.seenAt.getTime() < settleMs) {
      result.settling++;
      continue;
    }
    // Conditional, so two instances sharing the database alert once.
    const [claimed] = await db
      .update(prUpdateWatches)
      .set({ alertedHeadSha: head.headSha, alertedAt: now })
      .where(
        and(
          eq(prUpdateWatches.refKey, pr.refKey),
          or(
            isNull(prUpdateWatches.alertedHeadSha),
            ne(prUpdateWatches.alertedHeadSha, head.headSha),
          ),
        ),
      )
      .returning({ refKey: prUpdateWatches.refKey });
    if (!claimed) continue;
    result.started.push(pr.refKey);
    const work = alertUpdate(db, config, pr, head.headSha, deps)
      .catch((e) => console.error(`[pr-updates] ${shortPrName(pr.ref)} failed:`, describeError(e)))
      .finally(() => background.delete(work));
    background.add(work);
  }
  return result;
}

/**
 * The PRs in active review workspaces that the user has reviewed, one per PR.
 * A PR in several workspaces is watched in the one opened most recently.
 */
async function reviewedPrs(db: Db, deps: PrUpdateDeps): Promise<Watched[]> {
  const workspaces = (await listReviewWorkspaces(db))
    .filter((ws) => ws.status === "active")
    .sort((a, b) => (b.lastOpenedAt?.getTime() ?? 0) - (a.lastOpenedAt?.getTime() ?? 0));
  const byKey = new Map<string, ReviewWorkspacePrSummary>();
  for (const ws of workspaces) {
    for (const pr of ws.prs) {
      if (pr.status === "ready" && pr.headSha && !byKey.has(pr.refKey)) byKey.set(pr.refKey, pr);
    }
  }
  const watched: Watched[] = [];
  for (const pr of byKey.values()) {
    const mark = await latestMark(db, pr.ref, deps.review);
    if (mark) watched.push({ pr, mark });
  }
  return watched;
}

/** Fetches the new head, rechecks, and raises the item. */
async function alertUpdate(
  db: Db,
  config: Config,
  watchedPr: ReviewWorkspacePrSummary,
  head: string,
  deps: PrUpdateDeps,
): Promise<void> {
  const { workspaceId, id: prId } = watchedPr;
  const name = shortPrName(watchedPr.ref);
  const notes: string[] = [];

  let pr = await getReviewPr(db, workspaceId, prId);
  if (pr.headSha !== head) pr = await refreshTo(db, config, pr, deps);
  // A push during the refresh leaves the checkout on a later head, which is fine.
  const moved = pr.headSha !== watchedPr.headSha || pr.headSha === head;
  if (!moved) {
    notes.push(
      pr.error
        ? `Fetching the new commits failed (${pr.error}). Refresh the PR in its workspace.`
        : "The new commits haven't been fetched yet. Refresh the PR in its workspace.",
    );
  }

  const lines: string[] = [];
  const since = moved ? await sinceSummary(db, config, pr, deps) : null;
  if (since) lines.push(since.line);

  const threads = await threadSummary(pr.ref, since?.changedPaths ?? null, deps);
  if (threads) lines.push(threads);

  const recheck = moved ? await recheckVerification(db, config, pr, deps) : null;
  if (recheck) lines.push(recheck);

  const body = [`${name}${pr.title ? `: ${pr.title}` : ""}`, ...lines, ...notes].join("\n");
  await raiseAttention(db, {
    category: "review",
    kind: "action",
    title: "PR updated since your review",
    body,
    dedupeKey: prUpdatedAttentionKey(pr.refKey),
    navTarget: { type: "review-workspace", workspaceId, prId, tab: "since-review" },
  });
}

/** What changed since the user's review, in a line, and the paths it touched. */
async function sinceSummary(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: PrUpdateDeps,
): Promise<{ line: string; changedPaths: Set<string> } | null> {
  try {
    const since = await reviewSinceReview(db, config, pr.workspaceId, pr.id, deps.review);
    const changedPaths = new Set(
      since.files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])),
    );
    const newCommits = since.commits.filter((c) => c.isNew).length;
    let how = "";
    if (since.rebased) how = ", rebased or force-pushed";
    else if (since.baseMoved) how = ", base updated";
    return {
      line: `${plural(newCommits, "new commit")} and ${plural(since.files.length, "file")} changed since your review${how}.`,
      changedPaths,
    };
  } catch (e) {
    console.warn(
      `[pr-updates] could not read what changed in ${shortPrName(pr.ref)}:`,
      describeError(e),
    );
    return null;
  }
}

/** Moves the checkout to the PR's head, joining a refresh already running. Answers the PR as it ends up. */
async function refreshTo(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: PrUpdateDeps,
): Promise<ReviewWorkspacePr> {
  try {
    await refreshReviewPr(db, config, pr.workspaceId, pr.id, deps.review);
  } catch (e) {
    // A refresh the user started is already moving it; anything else is reported in the item.
    if (!(e instanceof ReviewWorkspaceError && e.status === 409)) {
      console.warn("[pr-updates] could not refresh:", describeError(e));
      return getReviewPr(db, pr.workspaceId, pr.id);
    }
  }
  const timeout = new Promise<void>((resolve) =>
    setTimeout(resolve, deps.refreshWaitMs ?? REFRESH_WAIT_MS),
  );
  await Promise.race([whenIdle(pr.id), timeout]);
  return getReviewPr(db, pr.workspaceId, pr.id);
}

/** Which of the user's review threads the new commits touch, and which are still open. */
async function threadSummary(
  ref: PrRef,
  changedPaths: Set<string> | null,
  deps: PrUpdateDeps,
): Promise<string | null> {
  try {
    const [detail, viewer] = await Promise.all([deps.loadDetail(ref), deps.viewer(ref)]);
    const mine = detail.reviewThreads.filter((t) =>
      t.comments.some((c) => sameIdentity(c, viewer)),
    );
    if (mine.length === 0) return null;
    const touched = mine.filter(
      (t) => t.isOutdated || (t.path !== null && changedPaths?.has(t.path) === true),
    ).length;
    const open = mine.filter((t) => !t.isResolved).length;
    return `Your threads: ${touched} of ${mine.length} touched by the new commits, ${open} still open.`;
  } catch (e) {
    console.warn("[pr-updates] could not read the review threads:", describeError(e));
    return null;
  }
}

/** The sections the PR's verification runs have covered, or none when it has no report. */
async function reportSections(db: Db, key: string): Promise<ReportSection[]> {
  const rows = await db
    .select({ meta: agentRuns.meta })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.kind, VERIFICATION_RUN_KIND),
        eq(agentRuns.status, "succeeded"),
        sql`${agentRuns.meta}->>'refKey' = ${key}`,
      ),
    )
    .orderBy(desc(agentRuns.startedAt));
  const sections = new Set<ReportSection>();
  for (const row of rows) {
    for (const s of runSections(row.meta as Record<string, unknown>)) sections.add(s);
  }
  return [...sections];
}

const RECHECK_TEXT: Record<VerifyOutcome["state"], string> = {
  done: "The verification checks were re-run on the new commits.",
  failed: "Re-running the verification checks failed",
  "needs-confirmation": "The verification checks weren't re-run: they need your go-ahead",
  cancelled: "Re-running the verification checks was cancelled.",
};

/**
 * Re-runs the checks the PR's report already has, at the new head, in one of
 * review prep's verification slots. Nothing when it has no report, or the
 * checkout didn't move.
 */
async function recheckVerification(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: PrUpdateDeps,
): Promise<string | null> {
  const sections = await reportSections(db, pr.refKey);
  if (sections.length === 0 || pr.worktreeStatus !== "ready") return null;
  try {
    const outcome = await withVerificationSlot(
      () => verifyAndWait(db, config, pr.ref, deps.kickoff, { sections }),
      deps.prepConfig,
    );
    const text = RECHECK_TEXT[outcome.state];
    return outcome.state === "failed" || outcome.state === "needs-confirmation"
      ? `${text}${outcome.note ? `: ${outcome.note}` : "."}`
      : text;
  } catch (e) {
    console.error("[pr-updates] the recheck failed:", describeError(e));
    return "Re-running the verification checks failed. See Settings → Diagnostics.";
  }
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const prUpdatesJob: JobDefinition = {
  name: "pr-updates",
  description:
    "Every 5 minutes, check the PRs you reviewed in a review workspace for new commits, fetch them, re-run their checks and tell you they're ready for another look.",
  schedule: { kind: "interval", everyMs: 5 * 60 * 1000 },
  run: async ({ db, config }) => {
    const result = await runPrUpdateWatch(db, config, defaultPrUpdateDeps(db, config));
    return {
      skipped: result.started.length === 0,
      detail: `alerting on ${result.started.length}, ${result.settling} settling`,
    };
  },
};
