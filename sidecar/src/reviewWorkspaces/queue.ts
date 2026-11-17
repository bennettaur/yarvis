/**
 * Verifying several pull requests in turn, such as a stack or a list the user
 * names to the assistant. Each PR's checks are a dozen Claude Code runs at
 * once, so the queue starts one PR's checks only after the last PR's have
 * ended, and rings the bell once at the end with how each went.
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
import type { PrRef } from "../pr/types.ts";
import { CHECKOUT_WAIT_MS, type KickoffDeps, kickOffVerification } from "./kickoff.ts";
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
  /** Whether it is safe to merge: malice, risk, claims and tests. */
  security: ["claims", "risk", "malice", "tests"],
  /** Every check but the flow diagram. */
  standard: DEFAULT_SECTIONS,
  /** Every section, the flow diagram included. */
  full: REPORT_SECTIONS,
} as const satisfies Record<string, readonly ReportSection[]>;

export type VerificationPreset = keyof typeof VERIFICATION_PRESETS;

/** Most PRs one queue takes: a deep stack, or a morning's review list. */
export const MAX_QUEUE_PRS = 10;
/** Queues kept for status questions after they finish; the oldest go first. */
const MAX_KEPT_QUEUES = 20;
const POLL_MS = 2000;

export type QueueItemState = "waiting" | "running" | "done" | "failed" | "needs-confirmation";

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
  items: QueueItem[];
  finished: boolean;
}

const queues = new Map<string, VerificationQueue>();

export const queueItemName = (ref: PrRef) =>
  `${ref.repo}#${ref.provider === "github" ? ref.number : ref.prId}`;

/** The queue as it stands, or null when this process never ran it or has let it go. */
export function getVerificationQueue(id: string): VerificationQueue | null {
  return queues.get(id) ?? null;
}

/**
 * Queues `refs` for verification, in order, and starts the first. Answers at
 * once; the bell rings when the last PR's checks end. A PR that needs the
 * user's go-ahead (large, over budget, or in a repo they never registered) is
 * skipped and named at the end, since agreeing to a queue isn't agreeing to
 * any one PR's cost.
 */
export function startVerificationQueue(
  db: Db,
  config: Config,
  refs: PrRef[],
  sections: readonly ReportSection[],
  deps: KickoffDeps,
): VerificationQueue {
  const queue: VerificationQueue = {
    id: randomUUID(),
    sections: [...sections],
    items: refs.slice(0, MAX_QUEUE_PRS).map((ref) => ({
      ref,
      name: queueItemName(ref),
      state: "waiting",
      note: null,
    })),
    finished: false,
  };
  queues.set(queue.id, queue);
  while (queues.size > MAX_KEPT_QUEUES) {
    const oldest = queues.keys().next().value;
    if (oldest === undefined) break;
    queues.delete(oldest);
  }
  void runQueue(db, config, queue, deps);
  return queue;
}

async function runQueue(
  db: Db,
  config: Config,
  queue: VerificationQueue,
  deps: KickoffDeps,
): Promise<void> {
  for (const item of queue.items) {
    item.state = "running";
    try {
      const outcome = await verifyOne(db, config, item.ref, queue.sections, deps);
      item.state = outcome.state;
      item.note = outcome.note;
    } catch (e) {
      console.error(`[verification] queue ${queue.id}: ${item.name} failed:`, describeError(e));
      item.state = "failed";
      item.note = "Starting its checks failed. See Settings → Diagnostics.";
    }
  }
  queue.finished = true;
  await notifyQueueDone(db, queue).catch((e) =>
    console.error("[verification] could not report the queue's end:", describeError(e)),
  );
}

type Outcome = { state: Exclude<QueueItemState, "waiting" | "running">; note: string | null };

/** Starts one PR's checks, waiting for its checkout first if it needs one, and waits for them to end. */
async function verifyOne(
  db: Db,
  config: Config,
  ref: PrRef,
  sections: ReportSection[],
  deps: KickoffDeps,
): Promise<Outcome> {
  const pollMs = deps.pollMs ?? POLL_MS;
  const deadline = Date.now() + (deps.waitMs ?? CHECKOUT_WAIT_MS);
  let result = await kickOffVerification(db, config, ref, { sections }, deps);
  while (result.status === "waiting-for-checkout") {
    if (Date.now() > deadline) return { state: "failed", note: "Its checkout didn't finish." };
    await Bun.sleep(pollMs);
    const pr = await getReviewPr(db, result.workspaceId, result.prId);
    if (pr.status === "error" || pr.worktreeStatus === "error") {
      return { state: "failed", note: "Its checkout failed." };
    }
    if (pr.status === "ready" && pr.worktreeStatus === "ready" && pr.headSha) {
      // The kickoff's own wait may start the checks first; this call then joins them.
      result = await kickOffVerification(db, config, ref, { sections }, deps);
    }
  }
  switch (result.status) {
    case "needs-confirmation":
      return { state: "needs-confirmation", note: CONFIRM_NOTE[result.reason] };
    case "error":
      return { state: "failed", note: result.error };
    case "exists":
      return { state: "done", note: "Already checked at this commit." };
    default: {
      const statuses = await Promise.all(result.runIds.map((id) => runEnd(db, id, deps)));
      const failed = statuses.filter((s) => s !== "succeeded").length;
      return failed === 0
        ? { state: "done", note: null }
        : { state: "failed", note: `${failed} of ${statuses.length} checks didn't finish.` };
    }
  }
}

const CONFIRM_NOTE: Record<string, string> = {
  large: "It's a large PR.",
  "over-budget": "It's over your budget.",
  unsized: "Its size couldn't be worked out.",
  "unregistered-repo": "Its repo isn't one you registered.",
};

/** How a run ended. One this process runs is followed; one another instance runs is polled. */
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
};

function notifyQueueDone(db: Db, queue: VerificationQueue) {
  const count = (state: QueueItemState) => queue.items.filter((i) => i.state === state).length;
  const failed = count("failed");
  const waiting = count("needs-confirmation");
  const lines = queue.items.map(
    (i) =>
      `${i.name}: ${STATE_TEXT[i.state as Outcome["state"]] ?? i.state}${i.note ? `. ${i.note}` : ""}`,
  );
  return createAttention(db, {
    source: "system",
    sessionKey: `pr-verification-queue:${queue.id}`,
    kind: failed > 0 ? "error" : waiting > 0 ? "info" : "completed",
    title: `Verification queue finished: ${count("done")} of ${queue.items.length} checked`,
    body: lines.join("\n"),
  });
}
