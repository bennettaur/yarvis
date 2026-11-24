import { and, eq, inArray } from "drizzle-orm";
import { agentRunRegistry } from "../agentRuns/service.ts";
import { raiseAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type ReviewPrepRow,
  type ReviewPrepState,
  reviewPreps,
  reviewWorkspacePrs,
  reviewWorkspaces,
} from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
import type { GuideKickoff } from "../pr/guideRun.ts";
import { openStackRefs } from "../pr/startReviewTools.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { verificationChecklist } from "../reviewWorkspaces/checklist.ts";
import {
  findReviewWorkspacePr,
  type KickoffDeps,
  shortPrName,
} from "../reviewWorkspaces/kickoff.ts";
import { type VerifyOutcome, verifyAndWait } from "../reviewWorkspaces/queue.ts";
import {
  addReviewPr,
  createReviewWorkspace,
  defaultReviewDeps,
  getReviewPr,
  locatorFor,
} from "../reviewWorkspaces/service.ts";
import { defaultVerificationDeps } from "../reviewWorkspaces/verification.ts";
import { findRepoForPr } from "../workspaces/service.ts";
import { getReviewPrepConfig, type ReviewPrepConfig } from "./config.ts";
import {
  choosePrepTier,
  type PrepTierDeps,
  startStory,
  storyNote,
  type TierChoice,
  tierLine,
} from "./sizeTier.ts";
import { prepBody, summarizePrep } from "./summary.ts";

/**
 * Review prep: given a pull request, opens a review workspace for it (or uses
 * the one it is already in), runs the verification report, and only then
 * raises an attention item, with the verdict, the files to read first and an
 * estimated review time. A run that fails still raises one, marked failed.
 *
 * Each PR's row in `review_preps` records the workspace it went into and how
 * verification ended; `review_workspaces.opened_by` records which workspaces
 * this opened, which are the only ones `archive.ts` archives on its own.
 *
 * It never runs the PR's setup script: that runs the PR's code unsandboxed,
 * and the user's go-ahead is given in the workspace for one script against one
 * commit. Nor does it confirm a run the kickoff would ask about (a large PR,
 * one over budget, or an unregistered repo); those wait for the user too.
 *
 * The queue is per process, like the verification queue it builds on. A prep
 * left mid-way by a restart is picked up again by the `review-prep` job.
 */

export interface ReviewPrepDeps {
  kickoff: KickoffDeps;
  /** The open PRs in a GitHub PR's stack, bottom first, the PR itself included. */
  loadStack?: (ref: PrRef) => Promise<PrRef[]>;
  prepConfig?: () => Promise<ReviewPrepConfig>;
  tier?: PrepTierDeps;
}

export function defaultPrepDeps(db: Db, config: Config): ReviewPrepDeps {
  return {
    kickoff: {
      review: defaultReviewDeps(db, config),
      verification: defaultVerificationDeps(config),
    },
    loadStack: (ref) => openStackRefs(config, ref),
  };
}

export type PrepResult =
  | {
      status: "queued" | "already-preparing" | "already-prepared";
      pr: string;
      workspaceId: string | null;
      /** True when this call opened a new review workspace for it. */
      createdWorkspace: boolean;
      /** For already-prepared: how it ended. */
      state?: ReviewPrepState;
    }
  /** Not started: the repo isn't one the user registered, and registering it is the user's call. */
  | { status: "needs-go-ahead"; pr: string; reason: "unregistered-repo" }
  | { status: "error"; pr: string; error: string };

export const IN_FLIGHT_STATES: ReviewPrepState[] = ["queued", "verifying"];

/** A prep that ended and whose workspace is still open is left alone; the user re-runs it there. */
const SETTLED_STATES: ReviewPrepState[] = ["ready", "failed", "needs-go-ahead"];

/** The dedupe key of a PR's attention item. */
export const prepAttentionKey = (key: string) => `review-prep:${key}`;

/** One find-or-create at a time, so a stack's layers prepped together share one workspace. */
const withPrepLock = createKeyedLock();
const PREP_LOCK = "review-prep";

/**
 * Runs `fn` while no prep can pick or create a workspace, so archiving can't
 * race a stack layer being added to the workspace it is archiving.
 */
export function whileNoPrepPlaces<T>(fn: () => Promise<T>): Promise<T> {
  return withPrepLock(PREP_LOCK, fn);
}

/**
 * Prepares `ref` for review, or says why it won't. Answers once the workspace
 * exists and the PR is queued; verification and the attention item follow in
 * the background.
 */
export function prepReview(
  db: Db,
  config: Config,
  ref: PrRef,
  deps: ReviewPrepDeps,
): Promise<PrepResult> {
  const name = shortPrName(ref);
  return withPrepLock(PREP_LOCK, async (): Promise<PrepResult> => {
    const key = refKey(ref);
    const [existing] = await db.select().from(reviewPreps).where(eq(reviewPreps.refKey, key));
    let found = await findReviewWorkspacePr(db, ref);

    if (existing && IN_FLIGHT_STATES.includes(existing.state)) {
      // Left alone: if a restart dropped it from the queue, the review-prep job requeues it.
      return {
        status: "already-preparing",
        pr: name,
        workspaceId: existing.workspaceId,
        createdWorkspace: false,
      };
    }
    if (
      existing &&
      found &&
      existing.workspaceId === found.workspaceId &&
      SETTLED_STATES.includes(existing.state)
    ) {
      return {
        status: "already-prepared",
        pr: name,
        workspaceId: existing.workspaceId,
        createdWorkspace: false,
        state: existing.state,
      };
    }

    let createdWorkspace = false;
    if (!found) {
      const isRegistered =
        deps.kickoff.isRegistered ??
        (async (r: PrRef) => (await findRepoForPr(db, locatorFor(r))) !== null);
      if (!(await isRegistered(ref))) {
        return { status: "needs-go-ahead", pr: name, reason: "unregistered-repo" };
      }
      const host = await stackHost(db, ref, deps);
      if (host) {
        const pr = await addReviewPr(db, config, host, ref, deps.kickoff.review);
        found = { workspaceId: host, prId: pr.id };
      } else {
        const ws = await createReviewWorkspace(
          db,
          config,
          { name, refs: [ref], openedBy: "review-prep" },
          deps.kickoff.review,
        );
        const pr = ws.prs[0];
        if (!pr) {
          return { status: "error", pr: name, error: "the review workspace has no PR in it" };
        }
        found = { workspaceId: ws.id, prId: pr.id };
        createdWorkspace = true;
      }
    }

    const values = {
      ref,
      workspaceId: found.workspaceId,
      prId: found.prId,
      state: "queued" as const,
      verdict: null,
      note: null,
      headSha: null,
      updatedAt: new Date(),
    };
    const [row] = await db
      .insert(reviewPreps)
      .values({ ...values, refKey: key, attentionKey: prepAttentionKey(key) })
      .onConflictDoUpdate({ target: reviewPreps.refKey, set: values })
      .returning();
    if (!row) return { status: "error", pr: name, error: "the prep couldn't be recorded" };
    enqueuePrep(db, config, row.id, deps);
    return { status: "queued", pr: name, workspaceId: found.workspaceId, createdWorkspace };
  });
}

/**
 * The review workspace that review prep opened for another open layer of `ref`'s
 * stack, so a stack is reviewed in one place. A layer the user opened by hand
 * doesn't count: adding to their workspace would change what they set up.
 */
async function stackHost(db: Db, ref: PrRef, deps: ReviewPrepDeps): Promise<string | null> {
  if (ref.provider !== "github" || !deps.loadStack) return null;
  let layers: PrRef[];
  try {
    layers = await deps.loadStack(ref);
  } catch (e) {
    // A stack that can't be read is reviewed on its own, as an unstacked PR is.
    console.error("[review-prep] could not read the stack:", describeError(e));
    return null;
  }
  const keys = layers.map(refKey).filter((k) => k !== refKey(ref));
  if (keys.length === 0) return null;
  const [row] = await db
    .select({ id: reviewWorkspaces.id })
    .from(reviewWorkspacePrs)
    .innerJoin(reviewWorkspaces, eq(reviewWorkspaces.id, reviewWorkspacePrs.workspaceId))
    .where(
      and(
        inArray(reviewWorkspacePrs.refKey, keys),
        eq(reviewWorkspaces.status, "active"),
        eq(reviewWorkspaces.openedBy, "review-prep"),
      ),
    )
    .limit(1);
  return row?.id ?? null;
}

// ---------------------------------------------------------------------------
// The queue
// ---------------------------------------------------------------------------

interface Waiting {
  id: string;
  db: Db;
  config: Config;
  deps: ReviewPrepDeps;
}

const waiting: Waiting[] = [];
const running = new Set<string>();
const background = new Set<Promise<void>>();

/** Whether this process has the prep queued or running. */
export function isPrepInFlight(id: string): boolean {
  return running.has(id) || waiting.some((w) => w.id === id);
}

/** Resolves once every prep this process queued has ended. For tests. */
export async function prepsSettled(): Promise<void> {
  while (background.size > 0 || waiting.length > 0) {
    if (background.size === 0) await Bun.sleep(10);
    else await Promise.allSettled([...background]);
  }
}

/** Queues a prep row to run once a verification slot is free. */
export function enqueuePrep(db: Db, config: Config, id: string, deps: ReviewPrepDeps): void {
  if (isPrepInFlight(id)) return;
  waiting.push({ id, db, config, deps });
  void pump();
}

let pumping = false;

async function pump(): Promise<void> {
  if (pumping) return;
  pumping = true;
  try {
    while (waiting.length > 0) {
      const next = waiting[0] as Waiting;
      const { maxConcurrentVerifications } = await (next.deps.prepConfig ?? getReviewPrepConfig)();
      if (running.size >= maxConcurrentVerifications) return;
      waiting.shift();
      running.add(next.id);
      const work = runPrep(next.db, next.config, next.id, next.deps)
        .catch((e) => console.error("[review-prep] a prep failed to start:", describeError(e)))
        .finally(() => {
          running.delete(next.id);
          background.delete(work);
          void pump();
        });
      background.add(work);
    }
  } finally {
    pumping = false;
  }
}

async function setState(db: Db, id: string, values: Partial<ReviewPrepRow>): Promise<void> {
  await db
    .update(reviewPreps)
    .set({ ...values, updatedAt: new Date() })
    .where(eq(reviewPreps.id, id));
}

async function runPrep(db: Db, config: Config, id: string, deps: ReviewPrepDeps): Promise<void> {
  // Claimed from `queued`, so a prep another instance requeued and took runs once.
  const [row] = await db
    .update(reviewPreps)
    .set({ state: "verifying", updatedAt: new Date() })
    .where(and(eq(reviewPreps.id, id), eq(reviewPreps.state, "queued")))
    .returning();
  if (!row) return;
  const name = shortPrName(row.ref);
  try {
    // A workspace the user closed while this waited its turn stays closed:
    // the kickoff would otherwise open a new one in their name.
    const found = await findReviewWorkspacePr(db, row.ref);
    if (!found || found.workspaceId !== row.workspaceId) {
      await setState(db, id, { state: "done", note: "Its review workspace was closed." });
      return;
    }
    const tier = await choosePrepTier(db, config, found, deps.kickoff, deps.tier);
    const story = tier.tier === "big" ? await startStory(db, config, row.ref, deps.tier) : null;
    const outcome = await verifyAndWait(db, config, row.ref, deps.kickoff, {
      sections: tier.sections,
    });
    await finishPrep(db, config, row, outcome, deps, tier, story);
  } catch (e) {
    console.error(`[review-prep] ${name} failed:`, describeError(e));
    await raiseFailed(db, row, "Preparing it failed. See Settings → Diagnostics.").catch((err) =>
      console.error("[review-prep] could not report the failure:", describeError(err)),
    );
  }
}

async function finishPrep(
  db: Db,
  config: Config,
  row: ReviewPrepRow,
  outcome: VerifyOutcome,
  deps: ReviewPrepDeps,
  tier: TierChoice,
  story: GuideKickoff["status"] | null,
): Promise<void> {
  const name = shortPrName(row.ref);
  const found = await findReviewWorkspacePr(db, row.ref);
  if (!found) {
    // The user removed the PR or archived the workspace while it ran.
    await setState(db, row.id, { state: "done", note: "Its review workspace was closed." });
    return;
  }
  const base = { workspaceId: found.workspaceId, prId: found.prId };
  if (outcome.state === "needs-confirmation") {
    const note = `${outcome.note ?? "It needs your go-ahead."} Run the checks from its review workspace.`;
    await setState(db, row.id, { ...base, state: "needs-go-ahead", note });
    await raise(db, row, found, "Review prep needs your go-ahead", `${name}: ${note}`);
    return;
  }
  if (outcome.state !== "done") {
    await setState(db, row.id, base);
    await raiseFailed(db, { ...row, ...base }, outcome.note ?? "Verification was cancelled.");
    return;
  }

  const pr = await getReviewPr(db, found.workspaceId, found.prId);
  const checklist = await verificationChecklist(
    db,
    config,
    found.workspaceId,
    found.prId,
    deps.kickoff.review,
    (id) => (deps.kickoff.verification.run?.registry ?? agentRunRegistry).isLive(id),
    deps.kickoff.verification.settings,
    deps.kickoff.verification.repoSettings,
  );
  const summary = summarizePrep(checklist.report, checklist.items, checklist.size, tier.sections);
  let body = prepBody(name, pr.title || null, summary);
  body += `\n${tierLine(tier, story && (await storyNote(db, row.ref, story)))}`;
  if (await setupWaiting(pr, deps)) {
    body +=
      "\nIts setup script hasn't run: it runs the PR's code, so it waits for your go-ahead in the workspace.";
  }
  await setState(db, row.id, {
    ...base,
    state: "ready",
    verdict: summary.verdict,
    headSha: checklist.headSha,
    note: null,
  });
  await raise(db, row, found, "Ready for review", body);
}

/** Whether the repo has a setup script the user hasn't agreed to for this commit. */
async function setupWaiting(
  pr: Awaited<ReturnType<typeof getReviewPr>>,
  deps: ReviewPrepDeps,
): Promise<boolean> {
  if (pr.setupConsent && pr.setupHeadSha === pr.headSha) return false;
  try {
    return (await deps.kickoff.review.setupScriptFor(pr.ref)) !== null;
  } catch (e) {
    console.error("[review-prep] could not read the setup script:", describeError(e));
    return false;
  }
}

async function raiseFailed(
  db: Db,
  row: Pick<ReviewPrepRow, "id" | "ref" | "attentionKey" | "workspaceId" | "prId">,
  reason: string,
): Promise<void> {
  await setState(db, row.id, { state: "failed", note: reason });
  const target =
    row.workspaceId && row.prId ? { workspaceId: row.workspaceId, prId: row.prId } : null;
  await raise(db, row, target, "Review prep failed", `${shortPrName(row.ref)}: ${reason}`);
}

/** Raises (or refreshes) the PR's one item. The title is always ours; the PR's own text is in the body. */
async function raise(
  db: Db,
  row: Pick<ReviewPrepRow, "id" | "attentionKey">,
  target: { workspaceId: string; prId: string } | null,
  title: string,
  body: string,
): Promise<void> {
  await raiseAttention(db, {
    category: "review",
    kind: "action",
    title,
    body,
    dedupeKey: row.attentionKey,
    navTarget: target
      ? {
          type: "review-workspace",
          workspaceId: target.workspaceId,
          prId: target.prId,
          tab: "verification",
        }
      : null,
  });
  await db.update(reviewPreps).set({ raisedAt: new Date() }).where(eq(reviewPreps.id, row.id));
}

/** Preps still queued or verifying, for the job to pick up after a restart. */
export async function inFlightPreps(db: Db): Promise<ReviewPrepRow[]> {
  return db.select().from(reviewPreps).where(inArray(reviewPreps.state, IN_FLIGHT_STATES));
}
