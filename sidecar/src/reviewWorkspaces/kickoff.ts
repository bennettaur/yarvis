import { agentRunRegistry, getAgentRunSummary } from "../agentRuns/service.ts";
import { createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { ReviewWorkspacePr } from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { findRepoForPr } from "../workspaces/service.ts";
import {
  createReviewWorkspace,
  getReviewPr,
  listReviewWorkspaces,
  locatorFor,
  type ReviewDeps,
  resumeIfStalled,
} from "./service.ts";
import {
  latestVerification,
  type ReportSection,
  startVerification,
  type VerificationDeps,
  type VerificationSize,
} from "./verification.ts";

/**
 * Starting a PR's verification report from somewhere other than its review
 * workspace, such as the assistant. It finds or makes the workspace, waits for
 * the checkout in the background, and reports back through the attention bell,
 * since whoever asked has usually moved on by the time the report is written.
 *
 * The in-flight state here is per process. A chat turn runs in one instance,
 * and `startVerification` itself refuses a second run across instances.
 */

/** Longest the background wait gives a clone and checkout before giving up. */
export const CHECKOUT_WAIT_MS = 15 * 60 * 1000;
const CHECKOUT_POLL_MS = 2000;

export interface KickoffOptions {
  sections?: readonly ReportSection[];
  /** The user agreed, after being told why, to a run that needs their go-ahead. */
  confirmed?: boolean;
  /** Run again even though a report for the PR's current head exists. */
  rerun?: boolean;
}

export interface KickoffDeps {
  review: ReviewDeps;
  verification: VerificationDeps;
  /** Whether the PR's repo is one the user registered; defaults to the repos table. */
  isRegistered?: (ref: PrRef) => Promise<boolean>;
  /** Overridden by tests so the wait doesn't take real seconds. */
  pollMs?: number;
  waitMs?: number;
}

/**
 * Why a run waits for the user: the same size and budget questions the review
 * tab asks before its Run button goes ahead, a PR that couldn't be sized, or a
 * repo the user never registered, since the name may have come from text
 * someone else wrote.
 */
export type ConfirmReason = "large" | "over-budget" | "unsized" | "unregistered-repo";

export type KickoffResult =
  | { status: "started"; workspaceId: string; prId: string; runId: string }
  | { status: "already-running"; workspaceId: string; prId: string; runId: string }
  /** A report for the PR's current head is already there. */
  | { status: "exists"; workspaceId: string; prId: string; runId: string }
  /** The checkout isn't ready yet; the report starts on its own once it is. */
  | { status: "waiting-for-checkout"; workspaceId: string; prId: string; createdWorkspace: boolean }
  | {
      status: "needs-confirmation";
      reason: ConfirmReason;
      /** Null before a workspace exists, for an unregistered repo. */
      workspaceId: string | null;
      prId: string | null;
      size: VerificationSize | null;
    }
  | { status: "error"; error: string };

/** Serializes find-or-create per PR, so two quick asks share one workspace. */
const withKickoffLock = createKeyedLock();

/**
 * The options each background wait will start with, by PR. A later ask
 * replaces them, so a confirmation sent while the clone runs isn't lost.
 */
const checkoutWaits = new Map<string, KickoffOptions>();

/** The active review workspace already holding `ref`, most recently opened first. */
async function findReviewWorkspacePr(
  db: Db,
  ref: PrRef,
): Promise<{ workspaceId: string; prId: string } | null> {
  const key = refKey(ref);
  for (const ws of await listReviewWorkspaces(db)) {
    if (ws.status !== "active") continue;
    const pr = ws.prs.find((p) => p.refKey === key);
    if (pr) return { workspaceId: ws.id, prId: pr.id };
  }
  return null;
}

const isCheckedOut = (pr: ReviewWorkspacePr) =>
  pr.status === "ready" && pr.worktreeStatus === "ready" && pr.headSha !== null;

const hasCheckoutFailed = (pr: ReviewWorkspacePr) =>
  pr.status === "error" || pr.worktreeStatus === "error";

/** "repo#12", the name the PRs tab gives a review workspace it creates. */
const shortPrName = (ref: PrRef) =>
  `${ref.repo}#${ref.provider === "github" ? ref.number : ref.prId}`;

const prName = (pr: ReviewWorkspacePr) => pr.title?.trim() || pr.refKey;

const registryFor = (deps: KickoffDeps) => deps.verification.run?.registry ?? agentRunRegistry;

/** Starts the verification report for `ref`, or says why it didn't. */
export function kickOffVerification(
  db: Db,
  config: Config,
  ref: PrRef,
  options: KickoffOptions,
  deps: KickoffDeps,
): Promise<KickoffResult> {
  return withKickoffLock(refKey(ref), async () => {
    let found = await findReviewWorkspacePr(db, ref);
    let createdWorkspace = false;
    if (!found) {
      const isRegistered =
        deps.isRegistered ?? (async (r) => (await findRepoForPr(db, locatorFor(r))) !== null);
      if (!options.confirmed && !(await isRegistered(ref))) {
        const none = { workspaceId: null, prId: null, size: null };
        return { status: "needs-confirmation", reason: "unregistered-repo", ...none };
      }
      const ws = await createReviewWorkspace(
        db,
        config,
        { name: shortPrName(ref), refs: [ref] },
        deps.review,
      );
      const pr = ws.prs[0];
      if (!pr) return { status: "error", error: "the review workspace was created without the PR" };
      found = { workspaceId: ws.id, prId: pr.id };
      createdWorkspace = true;
    }
    const { workspaceId, prId } = found;

    const pr = await getReviewPr(db, workspaceId, prId);
    // The reason is in the attention item and the workspace's log. It quotes
    // git, which can echo the author's branch name, so the model doesn't get it.
    if (hasCheckoutFailed(pr)) {
      return {
        status: "error",
        error: "the checkout failed; open the PR's review workspace to see why and retry",
      };
    }
    if (isCheckedOut(pr)) return startReport(db, config, pr, options, deps);

    const waiting = checkoutWaits.has(pr.refKey);
    checkoutWaits.set(pr.refKey, options);
    if (!waiting) {
      await resumeIfStalled(db, config, pr, deps.review);
      void startWhenCheckedOut(db, config, pr, deps).finally(() => checkoutWaits.delete(pr.refKey));
    }
    return { status: "waiting-for-checkout", workspaceId, prId, createdWorkspace };
  });
}

async function startReport(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  options: KickoffOptions,
  deps: KickoffDeps,
): Promise<KickoffResult> {
  const { workspaceId, id: prId } = pr;
  const latest = await latestVerification(
    db,
    config,
    workspaceId,
    prId,
    deps.review,
    (id) => registryFor(deps).isLive(id),
    deps.verification.settings,
  );
  if (latest.run?.live) {
    return { status: "already-running", workspaceId, prId, runId: latest.run.id };
  }
  if (!options.rerun && latest.lastSucceeded?.current) {
    return { status: "exists", workspaceId, prId, runId: latest.lastSucceeded.run.id };
  }
  if (!options.confirmed) {
    const { size } = latest;
    let reason: ConfirmReason | null = null;
    if (!size) reason = "unsized";
    else if (size.large) reason = "large";
    else if (size.overBudget) reason = "over-budget";
    if (reason) return { status: "needs-confirmation", reason, workspaceId, prId, size };
  }
  const started = await startVerification(
    db,
    config,
    workspaceId,
    prId,
    deps.review,
    deps.verification,
    options.sections,
  );
  // Only follow a run this call started. One already going was started by an
  // earlier ask, which follows it, or from the tab, where the user is watching.
  if (!started.existing) void notifyWhenDone(db, pr, started.runId, deps);
  return {
    status: started.existing ? "already-running" : "started",
    workspaceId,
    prId,
    runId: started.runId,
  };
}

const NOT_STARTED = "Verification report not started";

/** Polls until the PR is checked out, then starts the report with the latest ask's options. */
async function startWhenCheckedOut(
  db: Db,
  config: Config,
  initial: ReviewWorkspacePr,
  deps: KickoffDeps,
): Promise<void> {
  const deadline = Date.now() + (deps.waitMs ?? CHECKOUT_WAIT_MS);
  const pollMs = deps.pollMs ?? CHECKOUT_POLL_MS;
  let pr = initial;
  try {
    while (!isCheckedOut(pr)) {
      if (hasCheckoutFailed(pr)) {
        await notify(
          db,
          pr,
          "error",
          NOT_STARTED,
          `The checkout failed: ${pr.error ?? "unknown error"}`,
        );
        return;
      }
      if (Date.now() > deadline) {
        await notify(
          db,
          pr,
          "error",
          NOT_STARTED,
          "The checkout didn't finish. Open the review workspace to retry it.",
        );
        return;
      }
      await Bun.sleep(pollMs);
      pr = await getReviewPr(db, pr.workspaceId, pr.id);
    }
    const options = checkoutWaits.get(pr.refKey) ?? {};
    const result = await startReport(db, config, pr, options, deps);
    if (result.status === "needs-confirmation") {
      await notify(
        db,
        pr,
        "info",
        "Verification report needs your go-ahead",
        goAheadDetail(result),
      );
    }
  } catch (e) {
    console.error("[verification] background start failed:", describeError(e));
    await notify(
      db,
      pr,
      "error",
      NOT_STARTED,
      "Starting the report failed. See Settings → Diagnostics.",
    ).catch(() => undefined);
  }
}

function goAheadDetail(result: Extract<KickoffResult, { status: "needs-confirmation" }>): string {
  const { size } = result;
  const ask = "Run it from the review workspace, or ask again and confirm.";
  if (!size) return `Its size couldn't be worked out. ${ask}`;
  return `${size.files} files, ${size.changedLines} changed lines, about $${size.estimatedCostUsd.toFixed(2)} against a $${size.budgetUsd.toFixed(2)} budget. ${ask}`;
}

/** Rings the bell once a run this module started ends; whoever asked has usually moved on. */
async function notifyWhenDone(
  db: Db,
  pr: ReviewWorkspacePr,
  runId: string,
  deps: KickoffDeps,
): Promise<void> {
  try {
    // The run's row is written before the registry lets it go.
    await registryFor(deps).follow(runId, () => undefined);
    const run = await getAgentRunSummary(db, runId);
    if (run?.status === "succeeded") {
      await notify(db, pr, "completed", "Verification report ready", null);
    } else if (run?.status === "failed") {
      await notify(db, pr, "error", "Verification report failed", run.error);
    } else if (run?.status !== "cancelled") {
      console.error(
        `[verification] run ${runId} ended as ${run?.status ?? "missing"}; not notifying`,
      );
    }
  } catch (e) {
    console.error("[verification] could not report the run's end:", describeError(e));
  }
}

function notify(
  db: Db,
  pr: ReviewWorkspacePr,
  kind: "completed" | "error" | "info",
  title: string,
  detail: string | null,
) {
  // The PR's title is the author's text, so it goes in the body, never the
  // title, where it could pose as an app alert.
  return createAttention(db, {
    source: "system",
    sessionKey: `pr-verification:${pr.refKey}`,
    kind,
    title,
    body: detail ? `${prName(pr)}: ${detail}` : prName(pr),
    navTarget: {
      type: "review-workspace",
      workspaceId: pr.workspaceId,
      prId: pr.id,
      tab: "verification",
    },
  });
}
