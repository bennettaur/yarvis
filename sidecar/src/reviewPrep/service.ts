import { and, asc, count, eq, inArray } from "drizzle-orm";
import { agentRunRegistry } from "../agentRuns/service.ts";
import { subscribe } from "../attention/hub.ts";
import { raiseAttention, raisedSessionKey, resolveRaisedAttention } from "../attention/raise.ts";
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
import { createGitHubClient } from "../github/client.ts";
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
 * Further PRs wait in the queue as `waiting` rows, oldest first, with no
 * workspace yet, and start as slots free up. A stack starts whole, every open
 * layer at once, even past the limit; each layer holds a slot.
 *
 * The verification queue below that is per process, like the one it builds
 * on. A prep left mid-way by a restart is picked up again by the
 * `review-prep` job.
 */

export interface ReviewPrepDeps {
  kickoff: KickoffDeps;
  /** The open PRs in a GitHub PR's stack, bottom first, the PR itself included. */
  loadStack?: (ref: PrRef) => Promise<PrRef[]>;
  prepConfig?: () => Promise<ReviewPrepConfig>;
  /**
   * Which of `refs` no longer need the user's review, by refKey: merged,
   * closed, reviewed by the user, or approved. A queued PR in the answer
   * leaves the queue. Null when the provider can't be asked.
   */
  noLongerNeeded?: (refs: PrRef[]) => Promise<Set<string> | null>;
}

export function defaultPrepDeps(db: Db, config: Config): ReviewPrepDeps {
  return {
    kickoff: {
      review: defaultReviewDeps(db, config),
      verification: defaultVerificationDeps(config),
    },
    loadStack: (ref) => openStackRefs(config, ref),
    async noLongerNeeded(refs) {
      const token = config.secrets?.githubToken;
      if (!token) return null;
      const gh = createGitHubClient(config, token);
      const { login } = await gh.viewer();
      const github = refs.flatMap((r) => (r.provider === "github" ? [r] : []));
      const found = await gh.lookupReviewCandidates(github, login);
      return new Set(
        found
          .filter(
            (pr) =>
              pr.merged ||
              pr.summary.state === "closed" ||
              pr.reviewDecision === "approved" ||
              pr.myReviewStates.some((st) => st === "approved" || st === "changes_requested"),
          )
          .map((pr) =>
            refKey({
              provider: "github",
              owner: pr.summary.owner,
              repo: pr.summary.repo,
              number: pr.summary.number,
            }),
          ),
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
  /** In the queue: `maxReady` PRs are already prepared or being prepared. */
  | { status: "waiting"; pr: string; position: number }
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
 * exists and the PR is queued for verification, or once it is in the queue
 * for a slot; verification and the attention item follow in the background.
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

    if (existing?.state === "waiting") {
      return { status: "waiting", pr: name, position: await queuePosition(db, existing) };
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
        workspaceId: existing?.workspaceId ?? null,
        createdWorkspace: false,
        state: existing?.state,
      };
    }
    if (!found && !(await isRegistered(db, ref, deps))) {
      return { status: "needs-go-ahead", pr: name, reason: "unregistered-repo" };
    }

    const { maxReady } = await (deps.prepConfig ?? getReviewPrepConfig)();
    if ((await slotsInUse(db)) >= maxReady) {
      const row = await addToQueue(db, ref);
      return { status: "waiting", pr: name, position: await queuePosition(db, row) };
    }
    return startWithStack(db, config, ref, deps);
  });
}

function isSettledIn(
  existing: ReviewPrepRow | undefined,
  found: { workspaceId: string } | null,
): boolean {
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

async function addToQueue(db: Db, ref: PrRef): Promise<ReviewPrepRow> {
  const key = refKey(ref);
  const now = new Date();
  const values = {
    ref,
    workspaceId: null,
    prId: null,
    state: "waiting" as const,
    verdict: null,
    risk: null,
    note: null,
    headSha: null,
    queuedAt: now,
    updatedAt: now,
  };
  const [row] = await db
    .insert(reviewPreps)
    .values({ ...values, refKey: key, attentionKey: prepAttentionKey(key) })
    .onConflictDoUpdate({ target: reviewPreps.refKey, set: values })
    .returning();
  if (!row) throw new Error("the queued PR couldn't be recorded");
  return row;
}

/** The queue, oldest first. */
export async function queuedPreps(db: Db): Promise<ReviewPrepRow[]> {
  return db
    .select()
    .from(reviewPreps)
    .where(eq(reviewPreps.state, "waiting"))
    .orderBy(asc(reviewPreps.queuedAt), asc(reviewPreps.createdAt));
}

/** 1 for the next to start. */
async function queuePosition(db: Db, row: ReviewPrepRow): Promise<number> {
  const queue = await queuedPreps(db);
  const index = queue.findIndex((q) => q.id === row.id);
  return index === -1 ? queue.length : index + 1;
}

/**
 * Starts `ref`, then every other open layer of its stack that review prep
 * hasn't already started, so the stack is reviewed together. A layer waiting
 * in the queue starts with it. Runs under the prep lock.
 */
async function startWithStack(
  db: Db,
  config: Config,
  ref: PrRef,
  deps: ReviewPrepDeps,
): Promise<PrepResult> {
  const layers = await readStack(ref, deps);
  const result = await startPrep(db, config, ref, layers, deps);
  if (result.status !== "queued") return result;
  const stack: string[] = [];
  for (const layer of layers) {
    if (refKey(layer) === refKey(ref)) continue;
    const [existing] = await db
      .select()
      .from(reviewPreps)
      .where(eq(reviewPreps.refKey, refKey(layer)));
    if (existing && IN_FLIGHT_STATES.includes(existing.state)) continue;
    if (isSettledIn(existing, await findReviewWorkspacePr(db, layer))) continue;
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

/** Opens or picks `ref`'s workspace and queues its verification. Runs under the prep lock. */
async function startPrep(
  db: Db,
  config: Config,
  ref: PrRef,
  layers: PrRef[],
  deps: ReviewPrepDeps,
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

/**
 * Starts queued PRs, oldest first, while slots are free. A PR that no longer
 * needs the user's review, or whose repo is no longer registered, leaves the
 * queue instead. Returns how many it started, stack layers not counted.
 */
export function startQueuedPreps(db: Db, config: Config, deps: ReviewPrepDeps): Promise<number> {
  return withPrepLock(PREP_LOCK, async () => {
    const { maxReady } = await (deps.prepConfig ?? getReviewPrepConfig)();
    let started = 0;
    for (const queued of await queuedPreps(db)) {
      if ((await slotsInUse(db)) >= maxReady) break;
      // A layer of a stack started earlier in this loop has already left the queue.
      const [row] = await db.select().from(reviewPreps).where(eq(reviewPreps.id, queued.id));
      if (row?.state !== "waiting") continue;
      const name = shortPrName(row.ref);
      try {
        const gone = await noLongerNeeded(row.ref, deps);
        if (gone) {
          await dropFromQueue(db, row.id, "It no longer needed your review.");
          continue;
        }
        if (
          !(await findReviewWorkspacePr(db, row.ref)) &&
          !(await isRegistered(db, row.ref, deps))
        ) {
          await dropFromQueue(db, row.id, "Its repo is no longer registered.");
          continue;
        }
        const result = await startWithStack(db, config, row.ref, deps);
        if (result.status === "error") {
          await dropFromQueue(db, row.id, result.error);
          continue;
        }
        started++;
      } catch (e) {
        // Left in the queue: the next free slot or the review-prep job tries again.
        console.error(`[review-prep] could not start ${name}:`, describeError(e));
        break;
      }
    }
    return started;
  });
}

/** True only when the provider says so; an answer it can't give keeps the PR queued. */
async function noLongerNeeded(ref: PrRef, deps: ReviewPrepDeps): Promise<boolean> {
  if (!deps.noLongerNeeded) return false;
  try {
    return (await deps.noLongerNeeded([ref]))?.has(refKey(ref)) ?? false;
  } catch (e) {
    console.error("[review-prep] could not read a queued PR's state:", describeError(e));
    return false;
  }
}

/** Takes a PR out of the queue. Only while it is still waiting, so a PR started since stays started. */
export async function dropFromQueue(db: Db, id: string, note: string): Promise<boolean> {
  const [row] = await db
    .update(reviewPreps)
    .set({ state: "done", note, queuedAt: null, updatedAt: new Date() })
    .where(and(eq(reviewPreps.id, id), eq(reviewPreps.state, "waiting")))
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

/** Starts queued PRs in the background; failures are logged. */
export function startQueuedSoon(db: Db, config: Config, deps: ReviewPrepDeps): void {
  const work = startQueuedPreps(db, config, deps)
    .then(() => undefined)
    .catch((e) => console.error("[review-prep] could not start queued PRs:", describeError(e)))
    .finally(() => background.delete(work));
  background.add(work);
}

/**
 * Frees a prepared PR's slot as soon as the user dismisses its attention
 * item, and starts the next queued PR. Opening the item only marks it read,
 * which keeps the slot. The `review-prep` job does
 * the same for a dismissal this process didn't see.
 */
export function watchPrepDismissals(
  db: Db,
  config: Config,
  deps: () => ReviewPrepDeps = () => defaultPrepDeps(db, config),
): () => void {
  return subscribe((item) => {
    if (item.status !== "dismissed") return;
    if (!item.sessionKey?.startsWith(raisedSessionKey(prepAttentionKey("")))) return;
    const attentionKey = item.sessionKey.slice(raisedSessionKey("").length);
    void (async () => {
      const [row] = await db
        .select({ id: reviewPreps.id })
        .from(reviewPreps)
        .where(eq(reviewPreps.attentionKey, attentionKey));
      if (!row) return;
      if (await releasePrep(db, row.id, "You dismissed it.", { resolveItem: false })) {
        startQueuedSoon(db, config, deps());
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
          startQueuedSoon(next.db, next.config, next.deps);
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
