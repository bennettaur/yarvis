import { agentRunRegistry, getAgentRunSummary } from "../agentRuns/service.ts";
import { clearAttentionScope, createAttention } from "../attention/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { ReviewWorkspacePr } from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
import { type PrRef, refKey } from "../pr/types.ts";
import { findRepoForPr } from "../workspaces/service.ts";
import { verificationChecklist } from "./checklist.ts";
import {
  createReviewWorkspace,
  getReviewPr,
  listReviewWorkspaces,
  locatorFor,
  type ReviewDeps,
  resumeIfStalled,
} from "./service.ts";
import {
  checksCostUsd,
  normalizeSections,
  type ReportSection,
  startVerification,
  type VerificationDeps,
  type VerificationSize,
} from "./verification.ts";

/**
 * The size facts the model gets to relay. The file lists in
 * {@link VerificationSize} are left out: they are paths the PR's author chose.
 */
export type SizeSummary = Pick<
  VerificationSize,
  "files" | "changedLines" | "large" | "overBudget" | "estimatedCostUsd" | "budgetUsd"
>;

/** The size facts, with the estimate for the sections about to run rather than the defaults. */
function summarize(size: VerificationSize, sections: readonly ReportSection[]): SizeSummary {
  const estimatedCostUsd = checksCostUsd(size, sections);
  return {
    files: size.files,
    changedLines: size.changedLines,
    large: size.large,
    overBudget: estimatedCostUsd > size.budgetUsd,
    estimatedCostUsd,
    budgetUsd: size.budgetUsd,
  };
}

/**
 * Starting a PR's verification report from somewhere other than its review
 * workspace, such as the assistant. It finds or makes the workspace, waits for
 * the checkout in the background, and reports back through the attention bell,
 * since whoever asked has usually moved on by the time the report is written.
 *
 * The in-flight state here is per process. A chat turn runs in one instance,
 * and `startVerification` joins a section's run that another instance already
 * has going.
 */

/** Longest the background wait gives a clone and checkout before giving up. */
export const CHECKOUT_WAIT_MS = 15 * 60 * 1000;
const CHECKOUT_POLL_MS = 2000;

export interface KickoffOptions {
  sections?: readonly ReportSection[];
  /** The user agreed, after being told why, to a run that needs their go-ahead. */
  confirmed?: boolean;
  /** Run the sections again even where they have a result for the PR's current head. */
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
 * Why a run waits for the user: a large PR, an estimate over the budget for
 * the sections about to run, a PR that couldn't be sized, or a repo the user
 * never registered, since the name may have come from text someone else wrote.
 */
export type ConfirmReason = "large" | "over-budget" | "unsized" | "unregistered-repo";

/** What happened to each section asked for, so the model can say which ones run. */
export interface SectionOutcomes {
  started: ReportSection[];
  /** Already had a run going, which they joined. */
  running: ReportSection[];
  /** Already had a result for the PR's current head. */
  current: ReportSection[];
  /** Their run couldn't start. */
  failed: ReportSection[];
}

/**
 * Each section runs on its own. `runIds` are the runs behind the sections
 * started or running; a run from before sections ran on their own covers
 * several.
 */
type Ran = { workspaceId: string; prId: string; runIds: string[]; sections: SectionOutcomes };

export type KickoffResult =
  | ({ status: "started" } & Ran)
  /** No section was started: each already has a run going, or a current result. */
  | ({ status: "already-running" } & Ran)
  /** Every section asked for already has a result for the PR's current head. */
  | ({ status: "exists" } & Ran)
  /** The checkout isn't ready yet; the report starts on its own once it is. */
  | { status: "waiting-for-checkout"; workspaceId: string; prId: string; createdWorkspace: boolean }
  | {
      status: "needs-confirmation";
      reason: ConfirmReason;
      /** Null before a workspace exists, for an unregistered repo. */
      workspaceId: string | null;
      prId: string | null;
      size: SizeSummary | null;
    }
  | { status: "error"; error: string };

/** Serializes find-or-create per PR, so two quick asks share one workspace. */
const withKickoffLock = createKeyedLock();

/**
 * The options each background wait will start with, by PR. A later ask
 * replaces them, so the sections or re-run it names aren't lost.
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

const sessionKeyFor = (pr: ReviewWorkspacePr) => `pr-verification:${pr.refKey}`;

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

    const isAlreadyWaiting = checkoutWaits.has(pr.refKey);
    // Before the entry is set, so a failure here leaves no wait that isn't running.
    if (!isAlreadyWaiting) await resumeIfStalled(db, config, pr, deps.review);
    // Never `confirmed`: nobody has seen the PR's size yet, so a yes given now
    // (to an unregistered repo) can't also be a yes to its cost.
    checkoutWaits.set(pr.refKey, { ...options, confirmed: undefined });
    if (!isAlreadyWaiting) {
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
  const checklist = await verificationChecklist(
    db,
    config,
    workspaceId,
    prId,
    deps.review,
    (id) => registryFor(deps).isLive(id),
    deps.verification.settings,
  );
  const asked = normalizeSections(options.sections);
  const items = checklist.items.filter((item) => asked.includes(item.section));
  // Any instance's run counts, as it does for startVerification, which joins it.
  const running = items.filter((item) => item.latest?.status === "running");
  const current = items.filter((item) => !running.includes(item) && item.result?.current);
  const pending = items
    .filter((item) => !running.includes(item) && (options.rerun || !item.result?.current))
    .map((item) => item.section);
  const outcomes: SectionOutcomes = {
    started: [],
    running: running.map((item) => item.section),
    current: options.rerun ? [] : current.map((item) => item.section),
    failed: [],
  };
  const runningIds = running.flatMap((item) => item.latest?.id ?? []);

  if (pending.length === 0) {
    const runIds = [...new Set([...runningIds, ...current.flatMap((i) => i.result?.id ?? [])])];
    const status = running.length > 0 ? "already-running" : "exists";
    return { status, workspaceId, prId, runIds, sections: outcomes };
  }
  if (!options.confirmed) {
    const { size } = checklist;
    const summary = size ? summarize(size, pending) : null;
    let reason: ConfirmReason | null = null;
    if (!summary) reason = "unsized";
    else if (summary.large) reason = "large";
    else if (summary.overBudget) reason = "over-budget";
    if (reason) return { status: "needs-confirmation", reason, workspaceId, prId, size: summary };
  }
  // An earlier failure's bell item would otherwise sit beside this run's result.
  await clearAttentionScope(db, { sessionKey: sessionKeyFor(pr) }, "resolved");
  const started = await startVerification(
    db,
    config,
    workspaceId,
    prId,
    deps.review,
    deps.verification,
    pending,
  );
  // Only follow runs this call started. One already going was started by an
  // earlier ask, which follows it, or from the tab, where the user is watching.
  const fresh = started.runs.filter((r) => !r.existing);
  if (fresh.length > 0 || started.failed.length > 0)
    void notifyWhenDone(
      db,
      pr,
      fresh.map((r) => r.runId),
      started.failed.length,
      deps,
    );
  outcomes.started = fresh.map((r) => r.section);
  outcomes.running.push(...started.runs.filter((r) => r.existing).map((r) => r.section));
  outcomes.failed = started.failed.map((f) => f.section);
  return {
    status: fresh.length > 0 ? "started" : "already-running",
    workspaceId,
    prId,
    runIds: [...new Set([...runningIds, ...started.runs.map((r) => r.runId)])],
    sections: outcomes,
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
          // git's message can echo the author's branch name; the workspace shows it.
          "The checkout failed. Open the review workspace to see why and retry.",
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
  const why = result.reason === "large" ? "It's a large PR" : "It's over your budget";
  return `${why}: ${size.files} files, ${size.changedLines} changed lines, about $${size.estimatedCostUsd.toFixed(2)} against a $${size.budgetUsd.toFixed(2)} budget. ${ask}`;
}

/**
 * Rings the bell once every run this module started has ended; whoever asked
 * has usually moved on. A section whose run couldn't start counts as failed,
 * so a report missing it is never announced as ready.
 */
async function notifyWhenDone(
  db: Db,
  pr: ReviewWorkspacePr,
  runIds: string[],
  notStarted: number,
  deps: KickoffDeps,
): Promise<void> {
  try {
    // A run's row is written before the registry lets it go.
    await Promise.all(runIds.map((id) => registryFor(deps).follow(id, () => undefined)));
    const runs = await Promise.all(runIds.map((id) => getAgentRunSummary(db, id)));
    const statuses = runs.map((run) => run?.status ?? null);
    const failed = statuses.filter((s) => s === "failed").length + notStarted;
    const total = runIds.length + notStarted;
    if (failed === 0 && statuses.every((s) => s === "succeeded")) {
      await notify(db, pr, "completed", "Verification report ready", null);
    } else if (failed > 0) {
      // A run's error can quote what the agent read, so the bell gets a fixed line.
      const which = total === 1 ? "The check" : `${failed} of the ${total} checks`;
      await notify(
        db,
        pr,
        "error",
        "Verification report failed",
        `${which} failed. Open the review workspace to see why.`,
      );
    } else {
      // The rest were cancelled, which the user did and needs no bell, or
      // ended some way a run shouldn't, which is logged.
      const odd = statuses.some((s) => s !== "succeeded" && s !== "cancelled");
      if (odd) {
        console.error(
          `[verification] runs ${runIds.join(", ")} ended as ${statuses.join(", ")}; not notifying`,
        );
      }
    }
  } catch (e) {
    console.error("[verification] could not report the runs' end:", describeError(e));
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
    sessionKey: sessionKeyFor(pr),
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
