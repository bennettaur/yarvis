import { and, eq, inArray, isNull, lt, ne, or } from "drizzle-orm";
import {
  type AgentRunSummary,
  agentRunRegistry,
  getAgentRunSummary,
  ProcessSlots,
} from "../agentRuns/service.ts";
import { raiseAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type PrUpdateWatch, prUpdateWatches, type ReviewWorkspacePr } from "../db/schema.ts";
import { createGitHubClient, POLL_BATCH_SIZE } from "../github/client.ts";
import type { JobDefinition } from "../jobs/scheduler.ts";
import { describeError } from "../llm/errors.ts";
import { latestReviewMark } from "../pr/reviewMarks.ts";
import { prSourceFor } from "../pr/source.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { shortPrName } from "../reviewWorkspaces/kickoff.ts";
import { whenIdle } from "../reviewWorkspaces/progress.ts";
import {
  defaultRereviewDeps,
  isOutstanding,
  latestRereview,
  REREVIEW_RUN_TIMEOUT_MS,
  type Rereview,
  type RereviewDeps,
  sameIdentity,
  startRereview,
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
import { defaultPrepDeps } from "./service.ts";

/**
 * Re-review alerts: when a PR the user reviewed gets new commits, and it sits
 * in an active review workspace, this fetches them into the workspace, works
 * out what changed, runs "What's changed" over the new commits (are the
 * user's comments addressed, is there anything new to read, can they
 * approve), and then raises one "PR updated" item with that answer, which
 * opens the Since last review tab.
 *
 * "Reviewed" means the PR has a review mark: a review or line comment the user
 * posted (through Yarvis or on the provider), or "Mark reviewed here". A push
 * is acted on only once the head has stayed put for `SETTLE_MS`, so a burst of
 * pushes gives one alert. A merged or closed PR is left alone; the review-prep
 * job archives what it opened.
 */

/** How long a head must stay the same before it is acted on. */
const SETTLE_MS = 10 * 60 * 1000;

/** The longest it waits for a refresh to move the checkout. */
const REFRESH_WAIT_MS = 10 * 60 * 1000;

/**
 * Past this, an alert claimed but never raised is taken again. Longer than a
 * refresh and a "What's changed" run together.
 */
const STALE_CLAIM_MS = 2 * 60 * 60 * 1000;

const prUpdatedAttentionKey = (key: string) => `pr-updated:${key}`;

export interface ProviderHead {
  open: boolean;
  headSha: string | null;
}

export interface PrUpdateDeps {
  review: ReviewDeps;
  /** The "What's changed" run, and the PR's threads and who the user is there. */
  rereview: RereviewDeps;
  /** The provider's state and head for each ref, by refKey. A ref missing from the answer couldn't be read. */
  providerHeads(refs: PrRef[]): Promise<Map<string, ProviderHead>>;
  now?: () => Date;
  settleMs?: number;
  refreshWaitMs?: number;
}

function defaultPrUpdateDeps(db: Db, config: Config): PrUpdateDeps {
  return {
    review: defaultPrepDeps(db, config).kickoff.review,
    rereview: defaultRereviewDeps(config),
    providerHeads: (refs) => providerHeads(config, refs),
  };
}

/** GitHub refs go in batched status queries; an Azure PR is read one at a time. */
async function providerHeads(config: Config, refs: PrRef[]): Promise<Map<string, ProviderHead>> {
  const heads = new Map<string, ProviderHead>();
  const githubRefs = refs.flatMap((r) => (r.provider === "github" ? [r] : []));
  const token = config.secrets?.githubToken;
  if (githubRefs.length > 0 && token) {
    const gh = createGitHubClient(config, token);
    for (let i = 0; i < githubRefs.length; i += POLL_BATCH_SIZE) {
      const batch = githubRefs.slice(i, i + POLL_BATCH_SIZE);
      const results = await gh.prStatusesByNumber(batch);
      batch.forEach((ref, j) => {
        const result = results[j];
        if (!result?.ok) return;
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

const inFlightAlerts = new Set<Promise<void>>();

/** Resolves once every alert this process started has been raised or failed. For tests. */
export async function prUpdatesSettled(): Promise<void> {
  while (inFlightAlerts.size > 0) await Promise.allSettled([...inFlightAlerts]);
}

interface PrUpdateResult {
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
  const prs = await watchedPrs(db);
  const result: PrUpdateResult = { started: [], settling: 0 };
  if (prs.length === 0) return result;

  let heads: Map<string, ProviderHead>;
  try {
    heads = await deps.providerHeads(prs.map((pr) => pr.ref));
  } catch (e) {
    console.error("[pr-updates] could not read the PRs' heads:", describeError(e));
    return result;
  }
  const watches = new Map(
    (
      await db
        .select()
        .from(prUpdateWatches)
        .where(
          inArray(
            prUpdateWatches.refKey,
            prs.map((pr) => pr.refKey),
          ),
        )
    ).map((w) => [w.refKey, w]),
  );

  for (const pr of prs) {
    const head = heads.get(pr.refKey)?.open ? heads.get(pr.refKey)?.headSha : null;
    if (!head) continue;
    const watch = watches.get(pr.refKey);
    if (watch?.alertedHeadSha === head && !claimIsStale(watch, now)) continue;
    if (watch?.seenHeadSha !== head) {
      await db
        .insert(prUpdateWatches)
        .values({ refKey: pr.refKey, seenHeadSha: head, seenAt: now })
        .onConflictDoUpdate({
          target: prUpdateWatches.refKey,
          set: { seenHeadSha: head, seenAt: now },
        });
      // The provider is asked about the user's reviews once per new head, not on every run.
      const mark = await latestMark(db, pr.ref, deps.review);
      if (mark && mark.headSha !== head) result.settling++;
      continue;
    }
    const local = await latestReviewMark(db, pr.ref);
    if (!local || local.headSha === head) continue;
    if (now.getTime() - watch.seenAt.getTime() < settleMs) {
      result.settling++;
      continue;
    }
    // Asked again, for a review given on the new head while it settled.
    const mark = await latestMark(db, pr.ref, deps.review);
    if (!mark || mark.headSha === head) continue;
    if (!(await claimHead(db, pr.refKey, head, now))) continue;
    result.started.push(pr.refKey);
    const work = alertUpdate(db, config, pr, head, deps)
      .then(() => finishClaim(db, pr.refKey, head, "raised"))
      .catch(async (e) => {
        console.error(`[pr-updates] ${shortPrName(pr.ref)} failed:`, describeError(e));
        await finishClaim(db, pr.refKey, head, "failed").catch(() => {});
      })
      .finally(() => inFlightAlerts.delete(work));
    inFlightAlerts.add(work);
  }
  return result;
}

/**
 * A claim whose alert was never raised and has outlived anything the alert
 * waits on. The instance that took it likely stopped, so it may be taken again.
 */
function claimIsStale(watch: PrUpdateWatch, now: Date): boolean {
  return (
    !watch.alertedAt &&
    !!watch.alertingAt &&
    now.getTime() - watch.alertingAt.getTime() > STALE_CLAIM_MS
  );
}

/** Takes the alert for `head`; conditional, so two instances sharing the database alert once. */
async function claimHead(db: Db, key: string, head: string, now: Date): Promise<boolean> {
  const [claimed] = await db
    .update(prUpdateWatches)
    .set({ alertedHeadSha: head, alertingAt: now, alertedAt: null })
    .where(
      and(
        eq(prUpdateWatches.refKey, key),
        or(
          isNull(prUpdateWatches.alertedHeadSha),
          ne(prUpdateWatches.alertedHeadSha, head),
          and(
            isNull(prUpdateWatches.alertedAt),
            lt(prUpdateWatches.alertingAt, new Date(now.getTime() - STALE_CLAIM_MS)),
          ),
        ),
      ),
    )
    .returning({ refKey: prUpdateWatches.refKey });
  return !!claimed;
}

/** Marks the head's alert raised, or gives the claim back so the next run tries again. */
async function finishClaim(
  db: Db,
  key: string,
  head: string,
  outcome: "raised" | "failed",
): Promise<void> {
  await db
    .update(prUpdateWatches)
    .set(outcome === "raised" ? { alertedAt: new Date() } : { alertedHeadSha: null })
    .where(and(eq(prUpdateWatches.refKey, key), eq(prUpdateWatches.alertedHeadSha, head)));
}

/**
 * The ready PRs in active review workspaces, one per PR. A PR in several
 * workspaces is watched in the one opened most recently.
 */
async function watchedPrs(db: Db): Promise<ReviewWorkspacePrSummary[]> {
  const workspaces = (await listReviewWorkspaces(db))
    .filter((ws) => ws.status === "active")
    .sort((a, b) => (b.lastOpenedAt?.getTime() ?? 0) - (a.lastOpenedAt?.getTime() ?? 0));
  const byKey = new Map<string, ReviewWorkspacePrSummary>();
  for (const ws of workspaces) {
    for (const pr of ws.prs) {
      if (pr.status === "ready" && pr.headSha && !byKey.has(pr.refKey)) byKey.set(pr.refKey, pr);
    }
  }
  return [...byKey.values()];
}

/** Fetches the new head, runs "What's changed", and raises the item. */
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
  // A push during the refresh can leave the checkout past `head`, which is fine.
  const onNewCommits = pr.headSha !== watchedPr.headSha || pr.headSha === head;
  if (!onNewCommits) {
    notes.push(
      pr.error
        ? `Fetching the new commits failed (${pr.error}). Refresh the PR in its workspace.`
        : "The new commits haven't been fetched yet. Refresh the PR in its workspace.",
    );
  }

  const lines: string[] = [];
  const since = onNewCommits ? await sinceSummary(db, config, pr, deps) : null;
  if (since) lines.push(since.line);

  const rereview = onNewCommits ? await whatsChanged(db, config, pr, deps) : null;
  if (rereview?.answerLines) {
    lines.push(...rereview.answerLines);
  } else {
    const threads = await threadSummary(pr.ref, since?.changedPaths ?? null, deps);
    if (threads) lines.push(threads);
  }
  if (rereview?.note) lines.push(rereview.note);

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

/** Moves the checkout to the PR's head, joining a refresh already running. Returns the PR as it ends up. */
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, deps.refreshWaitMs ?? REFRESH_WAIT_MS);
  });
  try {
    await Promise.race([whenIdle(pr.id), timeout]);
  } finally {
    clearTimeout(timer);
  }
  return getReviewPr(db, pr.workspaceId, pr.id);
}

/** Which of the user's review threads the new commits touch, and which are still open. */
async function threadSummary(
  ref: PrRef,
  changedPaths: Set<string> | null,
  deps: PrUpdateDeps,
): Promise<string | null> {
  try {
    const [detail, viewer] = await Promise.all([
      deps.rereview.loadDetail(ref),
      deps.rereview.viewer(ref),
    ]);
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

interface WhatsChanged {
  /** The run's answer as item lines, when it finished with one. */
  answerLines: string[] | null;
  /** Why there is no answer, for the item. */
  note: string | null;
}

const noAnswer = (note: string): WhatsChanged => ({ answerLines: null, note });

/** A little past the run's own timeout, so the run ends itself first. */
const REREVIEW_WAIT_MS = REREVIEW_RUN_TIMEOUT_MS + 60_000;
const REREVIEW_POLL_MS = 2_000;

/**
 * Most "What's changed" runs this job starts at once. A burst of pushes
 * across watched PRs would otherwise start one Claude Code process per PR.
 */
const MAX_CONCURRENT_REREVIEWS = 2;
const rereviewSlots = new ProcessSlots(MAX_CONCURRENT_REREVIEWS);
const neverAborts = new AbortController().signal;

const usd = (amount: number) => `$${amount.toFixed(2)}`;

/**
 * Runs "What's changed" over the new commits and waits for its answer, or
 * reuses a run that already covers them. The rules are the Since last review
 * tab's: a run over its budget waits for the user's go-ahead, and one past
 * what an agent can read doesn't run at all.
 */
async function whatsChanged(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  deps: PrUpdateDeps,
): Promise<WhatsChanged> {
  if (pr.worktreeStatus !== "ready") {
    return noAnswer(
      "What's changed didn't run: the PR's checkout isn't ready. Refresh the PR in its workspace.",
    );
  }
  const registry = deps.rereview.run?.registry ?? agentRunRegistry;
  try {
    const fromLastReview = undefined;
    const latest = await latestRereview(
      db,
      pr.workspaceId,
      pr.id,
      deps.review,
      (id) => registry.isLive(id),
      fromLastReview,
      {
        config,
        settings: deps.rereview.settings,
        readerBudgetBytes: deps.rereview.readerBudgetBytes,
      },
    );
    let run: AgentRunSummary | null;
    if (latest.lastSucceeded?.current) {
      run = latest.lastSucceeded.run;
    } else if (latest.current && latest.run?.status === "running") {
      run = await waitForRunEnd(db, latest.run.id, registry);
    } else {
      const size = latest.size;
      if (!size) {
        return noAnswer(
          "What's changed didn't run: Yarvis couldn't work out how much changed. Start it from the Since last review tab.",
        );
      }
      if (size.overAgentBudget) {
        return noAnswer(
          "What's changed didn't run: there's too much to read at once. Read the changes in the Since last review tab.",
        );
      }
      if (size.overBudget) {
        return noAnswer(
          `What's changed didn't run: it needs your go-ahead, since it would cost about ${usd(size.estimatedCostUsd)}, over its ${usd(size.budgetUsd)} budget.`,
        );
      }
      const release = (await rereviewSlots.acquire(neverAborts)) as () => void;
      try {
        const { runId } = await startRereview(
          db,
          config,
          pr.workspaceId,
          pr.id,
          deps.review,
          deps.rereview,
        );
        run = await waitForRunEnd(db, runId, registry);
      } finally {
        release();
      }
    }
    if (run?.status === "succeeded" && run.result) {
      // The stored result is `checkedRereview`'s output, so it is already checked.
      return { answerLines: answerLines(run.result as Rereview), note: null };
    }
    if (run?.status === "running") {
      return noAnswer(
        "What's changed is still running. Its answer will be in the Since last review tab.",
      );
    }
    if (run?.status === "cancelled") return noAnswer("What's changed was cancelled.");
    return noAnswer("What's changed failed. See Settings → Diagnostics.");
  } catch (e) {
    if (e instanceof ReviewWorkspaceError)
      return noAnswer(`What's changed didn't run: ${e.message}.`);
    console.error("[pr-updates] What's changed failed:", describeError(e));
    return noAnswer("What's changed failed. See Settings → Diagnostics.");
  }
}

/**
 * Waits for a run to end, reading it from the database so a run another
 * instance started counts too. Returns it still running past the deadline.
 */
async function waitForRunEnd(
  db: Db,
  id: string,
  registry: typeof agentRunRegistry,
): Promise<AgentRunSummary | null> {
  // Waits out a run live in this process, which its own timeout bounds; one elsewhere is polled below.
  await registry.follow(id, () => undefined);
  const deadline = Date.now() + REREVIEW_WAIT_MS;
  for (;;) {
    const run = await getAgentRunSummary(db, id);
    if (run?.status !== "running" || Date.now() > deadline) return run;
    await Bun.sleep(REREVIEW_POLL_MS);
  }
}

/** The answer as counts; the agent's own words stay in the tab. */
function answerLines(answer: Rereview): string[] {
  const lines = [
    answer.verdict === "ready_to_approve"
      ? "What's changed: ready to approve."
      : "What's changed: needs another look.",
  ];
  const { comments } = answer;
  if (comments.length > 0) {
    const open = comments.filter(isOutstanding).length;
    lines.push(
      `Your comments: ${comments.length - open} of ${comments.length} addressed or resolved, ${open} still open.`,
    );
  }
  const toRead = answer.newChanges.filter((c) => c.kind === "needs_review").length;
  const minor = answer.newChanges.length - toRead;
  lines.push(
    toRead > 0
      ? `Other changes: ${plural(toRead, "change")} to read${minor > 0 ? `, ${minor} minor` : ""}.`
      : `Other changes: nothing new to read${minor > 0 ? ` (${minor} minor)` : ""}.`,
  );
  return lines;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

export const prUpdatesJob: JobDefinition = {
  name: "pr-updates",
  description:
    "Every 5 minutes, check the PRs you reviewed in a review workspace for new commits, fetch them, run What's changed over them and tell you they're ready for another look.",
  schedule: { kind: "interval", everyMs: 5 * 60 * 1000 },
  run: async ({ db, config, now }) => {
    const result = await runPrUpdateWatch(db, config, {
      ...defaultPrUpdateDeps(db, config),
      now: () => now,
    });
    return {
      skipped: result.started.length === 0,
      detail: `alerting on ${result.started.length}, ${result.settling} settling`,
    };
  },
};
