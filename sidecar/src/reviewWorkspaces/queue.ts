/**
 * Verifying several pull requests in turn, such as a stack or a list the user
 * names to the assistant. Each PR's checks are a dozen Claude Code runs at
 * once, so the queue starts one PR's checks only after the last PR's have
 * ended, runs one queue at a time, and rings the bell once at the end with
 * how each went.
 *
 * The queue is per process, like the kickoff it is built on: a chat turn runs
 * in one instance, and `startVerification` still refuses a second run of a
 * section across instances.
 */

import { randomUUID } from "node:crypto";
import { agentRunRegistry, getAgentRunSummary } from "../agentRuns/service.ts";
import { createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { describeError } from "../llm/errors.ts";
import type { RunChoice } from "../pr/models.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import {
  CHECKOUT_WAIT_MS,
  type ConfirmReason,
  type KickoffDeps,
  kickOffVerification,
  shortPrName,
} from "./kickoff.ts";
import { getReviewPr } from "./service.ts";
import {
  DEFAULT_SECTIONS,
  REPORT_SECTIONS,
  type ReportSection,
  VERIFICATION_RUN_TIMEOUT_MS,
} from "./verification.ts";

/** Named sets of sections, so "a quick look" or "a security pass" means the same every time. */
export const VERIFICATION_PRESETS = {
  /** What the PR does, what it is made of, and how risky it is. */
  quick: ["summary", "changeMap", "risk"],
  /** Whether it is safe to merge: claims, risk, malicious intent and tests. */
  security: ["claims", "risk", "malice", "tests"],
  /** Every check but the flow diagram. */
  standard: DEFAULT_SECTIONS,
  /** Every section, the flow diagram included. */
  full: REPORT_SECTIONS,
} as const satisfies Record<string, readonly ReportSection[]>;

export type VerificationPreset = keyof typeof VERIFICATION_PRESETS;

/** Most PRs one queue takes: a deep stack, or a morning's review list. */
export const MAX_QUEUE_PRS = 10;
/** Finished queues kept for status questions; the oldest go first. A running one is never dropped. */
const MAX_KEPT_QUEUES = 20;
const POLL_MS = 2000;

export type QueueItemState =
  | "waiting"
  | "running"
  | "done"
  | "failed"
  | "needs-confirmation"
  | "cancelled";

export interface QueueItem {
  ref: PrRef;
  /** "repo#12": built from the ref, never the PR's title, which its author wrote. */
  name: string;
  state: QueueItemState;
  /** Why it failed or needs a go-ahead, in Yarvis's words. */
  note: string | null;
}

export interface VerificationQueue {
  id: string;
  sections: ReportSection[];
  /** The model or effort every PR's checks run on, over the user's settings. */
  override: RunChoice;
  items: QueueItem[];
  finished: boolean;
  cancelled: boolean;
  /** The runs of the PR being checked now, so cancelling can stop them. */
  currentRunIds: string[];
}

const queues = new Map<string, VerificationQueue>();

/** The queue as it stands, or null when this process never ran it or has let it go. */
export function getVerificationQueue(id: string): VerificationQueue | null {
  return queues.get(id) ?? null;
}

/** The queue this process is running, if any. */
function runningQueue(): VerificationQueue | null {
  for (const queue of queues.values()) if (!queue.finished) return queue;
  return null;
}

/**
 * Queues `refs` for verification, in order, and starts the first; or, while
 * another queue is still running, answers with that one and starts nothing.
 * Answers at once; the bell rings when the last PR's checks end. A PR that
 * needs the user's go-ahead (large, over budget, or in a repo they never
 * registered) is skipped and named at the end, since agreeing to a queue
 * isn't agreeing to any one PR's cost.
 */
export function startVerificationQueue(
  db: Db,
  config: Config,
  refs: PrRef[],
  sections: readonly ReportSection[],
  deps: KickoffDeps,
  override: RunChoice = {},
): { queue: VerificationQueue; existing: boolean } {
  const running = runningQueue();
  if (running) return { queue: running, existing: true };
  if (refs.length > MAX_QUEUE_PRS) {
    throw new Error(`a queue takes at most ${MAX_QUEUE_PRS} PRs`);
  }
  const unique = [...new Map(refs.map((ref) => [refKey(ref), ref])).values()];
  const queue: VerificationQueue = {
    id: randomUUID(),
    sections: [...sections],
    override,
    items: unique.map((ref) => ({ ref, name: shortPrName(ref), state: "waiting", note: null })),
    finished: false,
    cancelled: false,
    currentRunIds: [],
  };
  queues.set(queue.id, queue);
  for (const [id, kept] of queues) {
    if (queues.size <= MAX_KEPT_QUEUES) break;
    if (kept.finished) queues.delete(id);
  }
  void runQueue(db, config, queue, deps);
  return { queue, existing: false };
}

/**
 * Stops a queue: the PRs not yet started are dropped, and the checks of the
 * one running now are cancelled. False when there is no such queue running.
 */
export function cancelVerificationQueue(id: string, deps: KickoffDeps): boolean {
  const queue = queues.get(id);
  if (!queue || queue.finished || queue.cancelled) return false;
  queue.cancelled = true;
  for (const item of queue.items) {
    if (item.state === "waiting") item.state = "cancelled";
  }
  const registry = deps.verification.run?.registry ?? agentRunRegistry;
  for (const runId of queue.currentRunIds) registry.cancel(runId);
  return true;
}

async function runQueue(
  db: Db,
  config: Config,
  queue: VerificationQueue,
  deps: KickoffDeps,
): Promise<void> {
  for (const item of queue.items) {
    if (queue.cancelled) break;
    item.state = "running";
    try {
      const outcome = await verifyOne(db, config, item.ref, queue, deps);
      item.state = outcome.state;
      item.note = outcome.note;
    } catch (e) {
      console.error(`[verification] queue ${queue.id}: ${item.name} failed:`, describeError(e));
      item.state = "failed";
      item.note = "Starting its checks failed. See Settings → Diagnostics.";
    }
    queue.currentRunIds = [];
  }
  queue.finished = true;
  await notifyQueueDone(db, queue).catch((e) =>
    console.error("[verification] could not report the queue's end:", describeError(e)),
  );
}

export type VerifyOutcome = {
  state: Exclude<QueueItemState, "waiting" | "running">;
  note: string | null;
  /** Why it needs the user's go-ahead, when it does. */
  confirmReason?: ConfirmReason;
};
type Outcome = VerifyOutcome;

/** Starts one PR's checks, waiting for its checkout first if it needs one, and waits for them to end. */
function verifyOne(
  db: Db,
  config: Config,
  ref: PrRef,
  queue: VerificationQueue,
  deps: KickoffDeps,
): Promise<Outcome> {
  return verifyAndWait(db, config, ref, deps, {
    sections: queue.sections,
    override: queue.override,
    isCancelled: () => queue.cancelled,
    onRuns: (runIds) => {
      queue.currentRunIds = runIds;
    },
  });
}

export interface VerifyAndWaitOptions {
  sections: readonly ReportSection[];
  override?: RunChoice;
  isCancelled?: () => boolean;
  /** Called with the runs it waits on, so the caller can cancel them. */
  onRuns?: (runIds: string[]) => void;
}

/**
 * Starts a PR's checks quietly (no bell of their own), waiting for its
 * checkout first if it needs one, and resolves once they have ended. A PR that
 * needs the user's go-ahead isn't started.
 */
export async function verifyAndWait(
  db: Db,
  config: Config,
  ref: PrRef,
  deps: KickoffDeps,
  { sections, override = {}, isCancelled = () => false, onRuns }: VerifyAndWaitOptions,
): Promise<VerifyOutcome> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = Date.now() + (deps.waitMs ?? CHECKOUT_WAIT_MS);
  const options = { sections, override, quiet: true };
  let result = await kickOffVerification(db, config, ref, options, deps);
  while (result.status === "waiting-for-checkout") {
    if (isCancelled()) return { state: "cancelled", note: null };
    if (Date.now() > deadline) return { state: "failed", note: "Its checkout didn't finish." };
    await Bun.sleep(pollMs);
    const pr = await getReviewPr(db, result.workspaceId, result.prId);
    if (pr.status === "error" || pr.worktreeStatus === "error") {
      return { state: "failed", note: "Its checkout failed." };
    }
    if (pr.status === "ready" && pr.worktreeStatus === "ready" && pr.headSha) {
      // The kickoff's own wait may start the checks first; this call then joins them.
      result = await kickOffVerification(db, config, ref, options, deps);
    }
  }
  switch (result.status) {
    case "needs-confirmation":
      return {
        state: "needs-confirmation",
        note: CONFIRM_NOTE[result.reason],
        confirmReason: result.reason,
      };
    case "error":
      return { state: "failed", note: result.error };
    case "exists":
      return { state: "done", note: "Already checked at this commit." };
    default: {
      onRuns?.(result.runIds);
      const statuses = await Promise.all(result.runIds.map((id) => runEnd(db, id, deps)));
      if (isCancelled()) return { state: "cancelled", note: null };
      // A section whose run never started didn't check anything either.
      const total = statuses.length + result.sections.failed.length;
      const failed =
        statuses.filter((s) => s !== "succeeded").length + result.sections.failed.length;
      return failed === 0
        ? { state: "done", note: null }
        : { state: "failed", note: `${failed} of ${total} checks didn't finish.` };
    }
  }
}

const CONFIRM_NOTE: Record<ConfirmReason, string> = {
  large: "It's a large PR.",
  "over-budget": "It's over your budget.",
  unsized: "Its size couldn't be worked out.",
  "unregistered-repo": "Its repo isn't one you registered.",
};

/**
 * How a run ended. One this process runs is followed to its end, which its
 * own timeout bounds. One another instance runs is polled; if that instance
 * died, the row stays "running" and this gives up after a run's longest time.
 */
async function runEnd(db: Db, id: string, deps: KickoffDeps): Promise<string> {
  await (deps.verification.run?.registry ?? agentRunRegistry).follow(id, () => undefined);
  const deadline = Date.now() + VERIFICATION_RUN_TIMEOUT_MS;
  for (;;) {
    const status = (await getAgentRunSummary(db, id))?.status ?? "missing";
    if (status !== "running" || Date.now() > deadline) return status;
    await Bun.sleep(deps.pollMs ?? POLL_MS);
  }
}

const STATE_TEXT: Record<Outcome["state"], string> = {
  done: "checked",
  failed: "failed",
  "needs-confirmation": "needs your go-ahead",
  cancelled: "cancelled",
};

function notifyQueueDone(db: Db, queue: VerificationQueue) {
  const count = (state: QueueItemState) => queue.items.filter((i) => i.state === state).length;
  const lines = queue.items.map(
    (i) =>
      `${i.name}: ${STATE_TEXT[i.state as Outcome["state"]] ?? i.state}${i.note ? `. ${i.note}` : ""}`,
  );
  let kind: "completed" | "error" | "info" = "completed";
  if (count("failed") > 0) kind = "error";
  else if (count("needs-confirmation") > 0 || queue.cancelled) kind = "info";
  return createAttention(db, {
    source: "system",
    sessionKey: `pr-verification-queue:${queue.id}`,
    kind,
    category: "review",
    title: `Verification queue ${queue.cancelled ? "cancelled" : "finished"}: ${count("done")} of ${queue.items.length} checked`,
    body: lines.join("\n"),
  });
}
