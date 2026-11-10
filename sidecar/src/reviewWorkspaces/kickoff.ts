import { agentRunRegistry, getAgentRunSummary } from "../agentRuns/service.ts";
import { createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { ReviewWorkspacePr } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import {
  createReviewWorkspace,
  getReviewPr,
  listReviewWorkspaces,
  type ReviewDeps,
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
 */

/** Longest the background wait gives a clone and checkout before giving up. */
export const CHECKOUT_WAIT_MS = 15 * 60 * 1000;
const CHECKOUT_POLL_MS = 2000;

export interface KickoffDeps {
  review: ReviewDeps;
  verification: VerificationDeps;
  /** Overridden by tests so the wait doesn't take real seconds. */
  pollMs?: number;
  waitMs?: number;
}

export type KickoffResult =
  | { status: "started"; workspaceId: string; prId: string; runId: string }
  | { status: "already-running"; workspaceId: string; prId: string; runId: string }
  /** The checkout isn't ready yet; the report starts on its own once it is. */
  | { status: "waiting-for-checkout"; workspaceId: string; prId: string; createdWorkspace: boolean }
  /** Large or over budget, so the user has to agree to the cost first. */
  | { status: "needs-confirmation"; workspaceId: string; prId: string; size: VerificationSize }
  | { status: "error"; error: string };

/** PRs with a background wait in progress, so a second ask doesn't start a second waiter. */
const waiting = new Set<string>();

/** The active review workspace already holding `ref`, most recently opened first. */
async function findPr(db: Db, ref: PrRef): Promise<{ workspaceId: string; prId: string } | null> {
  const key = refKey(ref);
  const workspaces = await listReviewWorkspaces(db);
  for (const ws of workspaces) {
    if (ws.status !== "active") continue;
    const pr = ws.prs.find((p) => p.refKey === key);
    if (pr) return { workspaceId: ws.id, prId: pr.id };
  }
  return null;
}

const checkedOut = (pr: ReviewWorkspacePr) =>
  pr.status === "ready" && pr.worktreeStatus === "ready" && pr.headSha !== null;

const checkoutFailed = (pr: ReviewWorkspacePr) =>
  pr.status === "error" || pr.worktreeStatus === "error";

/** "repo#12", the name the PRs tab gives a review workspace it creates. */
const shortPrName = (ref: PrRef) =>
  `${ref.repo}#${ref.provider === "github" ? ref.number : ref.prId}`;

const prName = (pr: ReviewWorkspacePr) => pr.title?.trim() || pr.refKey;

/**
 * Starts the verification report for `ref`, or says why it didn't.
 *
 * A PR past the size or budget the review tab warns about needs `confirmed`,
 * the same question the tab asks before its own Run button goes ahead.
 */
export async function kickOffVerification(
  db: Db,
  config: Config,
  ref: PrRef,
  options: { sections?: readonly ReportSection[]; confirmed?: boolean },
  deps: KickoffDeps,
): Promise<KickoffResult> {
  let found = await findPr(db, ref);
  let createdWorkspace = false;
  if (!found) {
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
  if (checkoutFailed(pr)) {
    return { status: "error", error: `the checkout failed: ${pr.error ?? "unknown error"}` };
  }
  if (checkedOut(pr)) return startChecked(db, config, pr, options, deps);

  if (!waiting.has(pr.refKey)) {
    waiting.add(pr.refKey);
    void startWhenCheckedOut(db, config, pr, options, deps).finally(() =>
      waiting.delete(pr.refKey),
    );
  }
  return { status: "waiting-for-checkout", workspaceId, prId, createdWorkspace };
}

async function startChecked(
  db: Db,
  config: Config,
  pr: ReviewWorkspacePr,
  options: { sections?: readonly ReportSection[]; confirmed?: boolean },
  deps: KickoffDeps,
): Promise<KickoffResult> {
  const { workspaceId, id: prId } = pr;
  const registry = deps.verification.run?.registry ?? agentRunRegistry;
  if (!options.confirmed) {
    const latest = await latestVerification(
      db,
      config,
      workspaceId,
      prId,
      deps.review,
      (id) => registry.isLive(id),
      deps.verification.settings,
    );
    if (latest.run?.live) {
      return { status: "already-running", workspaceId, prId, runId: latest.run.id };
    }
    if (latest.size && (latest.size.large || latest.size.overBudget)) {
      return { status: "needs-confirmation", workspaceId, prId, size: latest.size };
    }
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
  // A run that was already going has a notifier, or was started from the tab.
  if (!started.existing) void notifyWhenDone(db, pr, started.runId, deps);
  return {
    status: started.existing ? "already-running" : "started",
    workspaceId,
    prId,
    runId: started.runId,
  };
}

/** Polls until the PR is checked out, then starts the report as if it had been asked for then. */
async function startWhenCheckedOut(
  db: Db,
  config: Config,
  initial: ReviewWorkspacePr,
  options: { sections?: readonly ReportSection[]; confirmed?: boolean },
  deps: KickoffDeps,
): Promise<void> {
  const deadline = Date.now() + (deps.waitMs ?? CHECKOUT_WAIT_MS);
  const pollMs = deps.pollMs ?? CHECKOUT_POLL_MS;
  let pr = initial;
  try {
    while (!checkedOut(pr)) {
      if (checkoutFailed(pr)) {
        await notify(
          db,
          pr,
          "error",
          "Verification report not started",
          `The checkout failed: ${pr.error ?? "unknown error"}`,
        );
        return;
      }
      if (Date.now() > deadline) {
        await notify(
          db,
          pr,
          "error",
          "Verification report not started",
          "The checkout didn't finish in time.",
        );
        return;
      }
      await Bun.sleep(pollMs);
      pr = await getReviewPr(db, pr.workspaceId, pr.id);
    }
    const result = await startChecked(db, config, pr, options, deps);
    if (result.status === "needs-confirmation") {
      const { size } = result;
      await notify(
        db,
        pr,
        "info",
        "Verification report needs your go-ahead",
        `${size.files} files, ${size.changedLines} changed lines, about $${size.estimatedCostUsd.toFixed(2)} against a $${size.budgetUsd.toFixed(2)} budget. Run it from the review workspace, or ask again and confirm.`,
      );
    }
  } catch (e) {
    console.error("[verification] background start failed:", describeError(e));
    await notify(
      db,
      pr,
      "error",
      "Verification report not started",
      "Starting the report failed. See Settings → Diagnostics.",
    ).catch(() => undefined);
  }
}

/** Rings the bell once the run ends, whoever started it. */
async function notifyWhenDone(
  db: Db,
  pr: ReviewWorkspacePr,
  runId: string,
  deps: KickoffDeps,
): Promise<void> {
  const registry = deps.verification.run?.registry ?? agentRunRegistry;
  try {
    await registry.follow(runId, () => undefined);
    // The registry can let go a moment before the run's row is written.
    let run = await getAgentRunSummary(db, runId);
    for (let i = 0; run?.status === "running" && i < 30; i++) {
      await Bun.sleep(deps.pollMs ?? CHECKOUT_POLL_MS);
      run = await getAgentRunSummary(db, runId);
    }
    if (run?.status === "succeeded") {
      await notify(db, pr, "completed", "Verification report ready", null);
    } else if (run?.status !== "cancelled") {
      await notify(db, pr, "error", "Verification report failed", run?.error ?? null);
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
