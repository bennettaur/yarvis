import { and, asc, count, eq, inArray, isNull } from "drizzle-orm";
import { agentRunRegistry } from "../agentRuns/service.ts";
import { subscribe } from "../attention/hub.ts";
import { raiseAttention, raisedDedupeKey, resolveRaisedAttention } from "../attention/raise.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  type ReviewPrepRow,
  type ReviewPrepState,
  type RiskLevel,
  reviewPreps,
  reviewWorkspacePrs,
  reviewWorkspaces,
} from "../db/schema.ts";
import { createGitHubClient, type ReviewCandidate } from "../github/client.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
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
import { DEFAULT_SECTIONS, defaultVerificationDeps } from "../reviewWorkspaces/verification.ts";
import { findRepoForPr } from "../workspaces/service.ts";
import { getReviewPrepConfig, type ReviewPrepConfig } from "./config.ts";
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
 * At most `maxReady` PRs hold a slot at once (see {@link SLOT_STATES}).
 * Further PRs go into the backlog (`backlog` rows), oldest first, with no
 * workspace yet, and start as slots free up. A stack starts whole, its open
 * layers at once, even past the limit; each layer holds a slot. A backlogged
 * row is distinct from a `queued` one, which has started and is waiting for a
 * verification slot.
 *
 * Verification itself runs through a per-process queue (below), like the
 * verification queue it builds on. A prep left mid-way by a restart is picked
 * up again by the `review-prep` job.
 */

export interface ReviewPrepDeps {
  kickoff: KickoffDeps;
  /** The open PRs in a GitHub PR's stack, bottom first, the PR itself included. */
  loadStack?: (ref: PrRef) => Promise<PrRef[]>;
  prepConfig?: () => Promise<ReviewPrepConfig>;
  /**
   * Which of `refs` don't need the user's review, by refKey: see
   * {@link needsNoReview}. A backlogged PR in the answer leaves the backlog,
   * and a stack layer in it isn't started. Null when the provider can't be asked.
   */
  notNeedingReview?: (refs: PrRef[]) => Promise<Set<string> | null>;
}

/**
 * Merged, closed or approved, the user's own, or one the user already
 * approved or asked changes on. A comment alone doesn't count as a review.
 */
export function needsNoReview(pr: ReviewCandidate, viewer: string): boolean {
  return (
    pr.merged ||
    pr.summary.state === "closed" ||
    pr.reviewDecision === "approved" ||
    pr.summary.author === viewer ||
    pr.myReviewStates.some((st) => st === "approved" || st === "changes_requested")
  );
}

export function defaultPrepDeps(db: Db, config: Config): ReviewPrepDeps {
  return {
    kickoff: {
      review: defaultReviewDeps(db, config),
      verification: defaultVerificationDeps(config),
    },
    loadStack: (ref) => openStackRefs(config, ref),
    async notNeedingReview(refs) {
      const token = config.secrets?.githubToken;
      if (!token) return null;
      const gh = createGitHubClient(config, token);
      const { login } = await gh.viewer();
      const github = refs.flatMap((r) => (r.provider === "github" ? [r] : []));
      const found = await gh.lookupReviewCandidates(github, login);
      // Keyed by the ref asked about, not the name GitHub answers with, which
      // differs after a rename or in case.
      return new Set(
        github.flatMap((ref, i) => {
          const pr = found[i];
          return pr && needsNoReview(pr, login) ? [refKey(ref)] : [];
        }),
      );
    },
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
      /** For queued: the other layers of its stack started with it. */
      stack?: string[];
    }
  /** In the backlog: `maxReady` PRs are already prepared or being prepared. */
  | { status: "backlogged"; pr: string; position: number }
  /** Not started: the repo isn't one the user registered, and registering it is the user's call. */
  | { status: "needs-go-ahead"; pr: string; reason: "unregistered-repo" }
  | { status: "error"; pr: string; error: string };

export const IN_FLIGHT_STATES: ReviewPrepState[] = ["queued", "verifying"];

/**
 * The preps that hold one of the `maxReady` slots: from when one starts until
 * the user is done with it. A failed one doesn't, so a broken PR can't block
 * the stream.
 */
export const SLOT_STATES: ReviewPrepState[] = ["queued", "verifying", "ready", "needs-go-ahead"];

/** The slot holders the user can be done with. */
export const RELEASABLE_STATES: ReviewPrepState[] = ["ready", "needs-go-ahead"];

/** A prep that ended and whose workspace is still open is left alone; the user re-runs it there. */
const SETTLED_STATES: ReviewPrepState[] = ["ready", "failed", "needs-go-ahead", "released"];

/**
 * Most other layers of a stack started along with the PR picked. Stacks in
 * practice are a handful of layers; this keeps someone pushing a long chain on
 * top of a PR from starting a paid report for each. The rest are backlogged.
 */
const MAX_STACK_LAYERS_STARTED = 10;

/** Most backlogged PRs asked about in one provider call. */
const BACKLOG_LOOKUP_BATCH = 25;

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
 * exists and the PR is queued for verification, or once it is in the backlog;
 * verification and the attention item follow in the background.
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
    const found = await findReviewWorkspacePr(db, ref);

    if (existing?.state === "backlog") {
      startBackloggedSoon(db, config, deps);
      return { status: "backlogged", pr: name, position: await backlogPosition(db, existing) };
    }
    if (existing && IN_FLIGHT_STATES.includes(existing.state)) {
      // Left alone: if a restart dropped it from the queue, the review-prep job requeues it.
      return {
        status: "already-preparing",
        pr: name,
        workspaceId: existing.workspaceId,
        createdWorkspace: false,
      };
    }
    if (isSettledIn(existing, found)) {
      return {
        status: "already-prepared",
        pr: name,
        workspaceId: existing.workspaceId,
        createdWorkspace: false,
        state: existing.state,
      };
    }
    if (!found && !(await isRegistered(db, ref, deps))) {
      return { status: "needs-go-ahead", pr: name, reason: "unregistered-repo" };
    }

    const { maxReady } = await (deps.prepConfig ?? getReviewPrepConfig)();
    const full = (await slotsInUse(db)) >= maxReady;
    // Behind older backlogged PRs even when a slot is free, so a new pick can't jump them.
    if (full || (await backlogPreps(db)).length > 0) {
      const row = await addToBacklog(db, ref, { requested: true });
      if (!full) startBackloggedSoon(db, config, deps);
      return { status: "backlogged", pr: name, position: await backlogPosition(db, row) };
    }
    return startWithStack(db, config, ref, deps, { requested: true });
  });
}

function isSettledIn(
  existing: ReviewPrepRow | undefined,
  found: { workspaceId: string } | null,
): existing is ReviewPrepRow {
  return Boolean(
    existing &&
      found &&
      existing.workspaceId === found.workspaceId &&
      SETTLED_STATES.includes(existing.state),
  );
}

async function isRegistered(db: Db, ref: PrRef, deps: ReviewPrepDeps): Promise<boolean> {
  const check =
    deps.kickoff.isRegistered ??
    (async (r: PrRef) => (await findRepoForPr(db, locatorFor(r))) !== null);
  return check(ref);
}

/** How many preps hold a slot. */
export async function slotsInUse(db: Db): Promise<number> {
  const [row] = await db
    .select({ n: count() })
    .from(reviewPreps)
    .where(inArray(reviewPreps.state, SLOT_STATES));
  return row?.n ?? 0;
}

/**
 * `requested` is set when `prepReview` was called for this PR, as opposed to
 * a stack layer coming along with one: only those count toward a heads-down
 * pass's prep limit.
 */
interface StartOptions {
  requested?: boolean;
}

async function addToBacklog(
  db: Db,
  ref: PrRef,
  { requested = false }: StartOptions = {},
): Promise<ReviewPrepRow> {
  const key = refKey(ref);
  const now = new Date();
  const values = {
    ...(requested ? { requestedAt: now } : {}),
    ref,
    workspaceId: null,
    prId: null,
    state: "backlog" as const,
    verdict: null,
    risk: null,
    note: null,
    headSha: null,
    backloggedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(reviewPreps)
    .values({ ...values, refKey: key, attentionKey: prepAttentionKey(key) })
    .onConflictDoUpdate({ target: reviewPreps.refKey, set: values })
    .returning();
  if (!row) throw new Error("the backlogged PR couldn't be recorded");
  return row;
}

/** The `backlog` rows, oldest first, which is the order they start in. */
export async function backlogPreps(db: Db): Promise<ReviewPrepRow[]> {
  return db
    .select()
    .from(reviewPreps)
    .where(eq(reviewPreps.state, "backlog"))
    .orderBy(asc(reviewPreps.backloggedAt), asc(reviewPreps.createdAt));
}

/** 1 for the next to start. */
async function backlogPosition(db: Db, row: ReviewPrepRow): Promise<number> {
  const backlog = await backlogPreps(db);
  const index = backlog.findIndex((b) => b.id === row.id);
  return index === -1 ? backlog.length : index + 1;
}

/**
 * Starts `ref`, then the other open layers of its stack, so the stack is
 * reviewed together. A layer starts only if review prep has no row for it or
 * has it in the backlog: one the user already finished with stays finished.
 * Layers that don't need the user's review are skipped, since the scout never
 * vetted them. Runs under the prep lock.
 */
async function startWithStack(
  db: Db,
  config: Config,
  ref: PrRef,
  deps: ReviewPrepDeps,
  options: StartOptions = {},
): Promise<PrepResult> {
  const layers = await readStack(ref, deps);
  const result = await startPrep(db, config, ref, layers, deps, options);
  if (result.status !== "queued") return result;
  const others = layers.filter((layer) => refKey(layer) !== refKey(ref));
  if (others.length === 0) return result;
  const skip = await whichNeedNoReview(others, deps);
  const stack: string[] = [];
  for (const layer of others) {
    if (skip.has(refKey(layer))) continue;
    const [existing] = await db
      .select()
      .from(reviewPreps)
      .where(eq(reviewPreps.refKey, refKey(layer)));
    if (existing && existing.state !== "backlog") continue;
    if (stack.length >= MAX_STACK_LAYERS_STARTED) {
      if (!existing) await addToBacklog(db, layer);
      continue;
    }
    const started = await startPrep(db, config, layer, layers, deps);
    if (started.status === "queued") stack.push(started.pr);
  }
  return stack.length > 0 ? { ...result, stack } : result;
}

/** The open layers of `ref`'s stack, bottom first; empty when it has none or can't be read. */
async function readStack(ref: PrRef, deps: ReviewPrepDeps): Promise<PrRef[]> {
  if (ref.provider !== "github" || !deps.loadStack) return [];
  try {
    return await deps.loadStack(ref);
  } catch (e) {
    // A stack that can't be read is reviewed on its own, as an unstacked PR is.
    console.error("[review-prep] could not read the stack:", describeError(e));
    return [];
  }
}

/**
 * The refKeys of `refs` the provider says don't need the user's review, asked
 * in batches. An answer it can't give counts as needing review, so nothing is
 * dropped on a guess.
 */
export async function whichNeedNoReview(refs: PrRef[], deps: ReviewPrepDeps): Promise<Set<string>> {
  const found = new Set<string>();
  if (!deps.notNeedingReview) return found;
  for (let i = 0; i < refs.length; i += BACKLOG_LOOKUP_BATCH) {
    try {
      const answer = await deps.notNeedingReview(refs.slice(i, i + BACKLOG_LOOKUP_BATCH));
      for (const key of answer ?? []) found.add(key);
    } catch (e) {
      console.error("[review-prep] could not read the PRs' review state:", describeError(e));
      break;
    }
  }
  return found;
}

/** Opens or picks `ref`'s workspace and queues its verification. Runs under the prep lock. */
async function startPrep(
  db: Db,
  config: Config,
  ref: PrRef,
  layers: PrRef[],
  deps: ReviewPrepDeps,
  { requested = false }: StartOptions = {},
): Promise<PrepResult> {
  const name = shortPrName(ref);
  const key = refKey(ref);
  let found = await findReviewWorkspacePr(db, ref);
  let createdWorkspace = false;
  if (!found) {
    const host = await stackHost(db, ref, layers);
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
    risk: null,
    note: null,
    headSha: null,
    backloggedAt: null,
    updatedAt: new Date(),
    ...(requested ? { requestedAt: new Date() } : {}),
  };
  const [row] = await db
    .insert(reviewPreps)
    .values({ ...values, refKey: key, attentionKey: prepAttentionKey(key) })
    .onConflictDoUpdate({ target: reviewPreps.refKey, set: values })
    .returning();
  if (!row) return { status: "error", pr: name, error: "the prep couldn't be recorded" };
  enqueuePrep(db, config, row.id, deps);
  return { status: "queued", pr: name, workspaceId: found.workspaceId, createdWorkspace };
}

/**
 * The review workspace that review prep opened for another open layer of `ref`'s
 * stack, so a stack is reviewed in one place. A layer the user opened by hand
 * doesn't count: adding to their workspace would change what they set up.
 */
async function stackHost(db: Db, ref: PrRef, layers: PrRef[]): Promise<string | null> {
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

export interface BacklogResult {
  started: number;
  dropped: number;
}

/**
 * Drops backlogged PRs that don't need the user's review any more, then
 * starts the rest, oldest first, while slots are free. One whose repo is no
 * longer registered leaves the backlog too. `started` doesn't count stack
 * layers started along with a PR.
 */
export async function startBackloggedPreps(
  db: Db,
  config: Config,
  deps: ReviewPrepDeps,
): Promise<BacklogResult> {
  const backlog = await backlogPreps(db);
  if (backlog.length === 0) return { started: 0, dropped: 0 };
  // Asked before taking the lock, so a slow provider doesn't hold up a prep the user asked for.
  const skip = await whichNeedNoReview(
    backlog.map((row) => row.ref),
    deps,
  );
  return withPrepLock(PREP_LOCK, async () => {
    let dropped = 0;
    for (const row of backlog) {
      if (!skip.has(row.refKey)) continue;
      if (await dropFromBacklog(db, row.id, "It no longer needed your review.")) dropped++;
    }
    const { maxReady } = await (deps.prepConfig ?? getReviewPrepConfig)();
    let started = 0;
    for (const next of await backlogPreps(db)) {
      if ((await slotsInUse(db)) >= maxReady) break;
      // Claimed by moving it to `queued`, so another instance sharing the
      // database can't start it too. A stack layer started earlier in this
      // loop has already left the backlog.
      const [row] = await db
        .update(reviewPreps)
        .set({ state: "queued", updatedAt: new Date() })
        .where(and(eq(reviewPreps.id, next.id), eq(reviewPreps.state, "backlog")))
        .returning();
      if (!row) continue;
      try {
        if (
          !(await findReviewWorkspacePr(db, row.ref)) &&
          !(await isRegistered(db, row.ref, deps))
        ) {
          await leaveBacklog(db, row.id, "Its repo is no longer registered.");
          dropped++;
          continue;
        }
        const result = await startWithStack(db, config, row.ref, deps);
        if (result.status === "error") {
          await leaveBacklog(db, row.id, result.error);
          dropped++;
          continue;
        }
        started++;
      } catch (e) {
        // To the back, so a PR that fails every time can't hold up the rest.
        // Stopping here means a provider that is down is tried once per drain.
        console.error(`[review-prep] could not start ${shortPrName(row.ref)}:`, describeError(e));
        await db
          .update(reviewPreps)
          .set({ state: "backlog", backloggedAt: new Date(), updatedAt: new Date() })
          .where(
            and(
              eq(reviewPreps.id, row.id),
              eq(reviewPreps.state, "queued"),
              isNull(reviewPreps.workspaceId),
            ),
          );
        break;
      }
    }
    return { started, dropped };
  });
}

/** Ends a PR claimed from the backlog that couldn't start. */
async function leaveBacklog(db: Db, id: string, note: string): Promise<void> {
  await db
    .update(reviewPreps)
    .set({ state: "done", note, backloggedAt: null, updatedAt: new Date() })
    .where(and(eq(reviewPreps.id, id), isNull(reviewPreps.workspaceId)));
}

/** Takes a PR out of the backlog. Only while it is still there, so a PR started since stays started. */
export async function dropFromBacklog(db: Db, id: string, note: string): Promise<boolean> {
  const [row] = await db
    .update(reviewPreps)
    .set({ state: "done", note, backloggedAt: null, updatedAt: new Date() })
    .where(and(eq(reviewPreps.id, id), eq(reviewPreps.state, "backlog")))
    .returning({ id: reviewPreps.id });
  return Boolean(row);
}

/**
 * Frees a prepared PR's slot when the user is done with it but its workspace
 * stays open. Only from a settled state, so a prep running again isn't cut
 * short. Resolves its item when the reason wasn't the user dismissing it.
 */
export async function releasePrep(
  db: Db,
  id: string,
  note: string,
  { resolveItem }: { resolveItem: boolean },
): Promise<boolean> {
  const [row] = await db
    .update(reviewPreps)
    .set({ state: "released", note, updatedAt: new Date() })
    .where(and(eq(reviewPreps.id, id), inArray(reviewPreps.state, RELEASABLE_STATES)))
    .returning();
  if (!row) return false;
  if (resolveItem) await resolveRaisedAttention(db, row.attentionKey);
  return true;
}

/** Starts backlogged PRs in the background; failures are logged. */
export function startBackloggedSoon(db: Db, config: Config, deps: ReviewPrepDeps): void {
  const work = startBackloggedPreps(db, config, deps)
    .then(() => undefined)
    .catch((e) => console.error("[review-prep] could not start backlogged PRs:", describeError(e)))
    .finally(() => background.delete(work));
  background.add(work);
}

/**
 * Frees a prepared PR's slot as soon as the user dismisses its attention
 * item, and starts the next backlogged PR. Opening the item only marks it
 * read, which keeps the slot. The `review-prep` job does the same for a
 * dismissal this process didn't see.
 */
export function watchPrepDismissals(
  db: Db,
  config: Config,
  deps: () => ReviewPrepDeps = () => defaultPrepDeps(db, config),
): () => void {
  return subscribe((item) => {
    if (item.status !== "dismissed" || !item.sessionKey) return;
    const attentionKey = raisedDedupeKey(item.sessionKey);
    if (!attentionKey?.startsWith(prepAttentionKey(""))) return;
    void (async () => {
      const [row] = await db
        .select({ id: reviewPreps.id })
        .from(reviewPreps)
        .where(eq(reviewPreps.attentionKey, attentionKey));
      if (!row) return;
      if (await releasePrep(db, row.id, "You dismissed it.", { resolveItem: false })) {
        startBackloggedSoon(db, config, deps());
      }
    })().catch((e) =>
      console.error("[review-prep] could not release a dismissed prep:", describeError(e)),
    );
  });
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
          // A prep that failed or found its workspace closed frees its slot.
          startBackloggedSoon(next.db, next.config, next.deps);
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
    const outcome = await verifyAndWait(db, config, row.ref, deps.kickoff, {
      sections: DEFAULT_SECTIONS,
    });
    await finishPrep(db, config, row, outcome, deps);
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
  );
  const summary = summarizePrep(checklist.report, checklist.items, checklist.size);
  let body = prepBody(name, pr.title || null, summary);
  if (await setupWaiting(pr, deps)) {
    body +=
      "\nIts setup script hasn't run: it runs the PR's code, so it waits for your go-ahead in the workspace.";
  }
  const risk = checklist.report?.risk?.level ?? null;
  await setState(db, row.id, {
    ...base,
    state: "ready",
    verdict: summary.verdict,
    risk,
    headSha: checklist.headSha,
    note: null,
  });
  await raise(db, row, found, "Ready for review", body, risk);
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
  risk: RiskLevel | null = null,
): Promise<void> {
  await raiseAttention(db, {
    category: "review",
    kind: "action",
    title,
    body,
    risk,
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
