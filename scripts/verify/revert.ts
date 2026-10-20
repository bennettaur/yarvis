#!/usr/bin/env bun
/**
 * Backs out an auto-merged PR that broke `main`. Run by
 * `.github/workflows/verify-revert.yml` when CI fails on a push to `main`.
 *
 * Only PRs the gate auto-approved are reverted: a person who approved a PR
 * has already taken it on, and gets the failing build to look at instead.
 * A first failure is re-run rather than reverted, since one flaky test
 * shouldn't undo a good change, and a failure that was already there on the
 * parent commit isn't this PR's.
 *
 * The revert goes through GitHub's own revert, which opens a PR whose body
 * starts `Reverts owner/repo#N`. That line is what `calibrate.ts` counts. A
 * maintainer still merges the revert.
 *
 * Env: GH_TOKEN (the yarvis bot's installation token), GH_REPO, BOT_SLUG (the
 * yarvis app's slug), HEAD_SHA (the commit CI failed on), RUN_ID and
 * RUN_ATTEMPT (the failed CI run), RUN_URL.
 */

import { ghApi, ghApiPages, run } from "./exec.ts";
import { MAINTAINER_ASSOCIATIONS, type MergePath, mergePath } from "./gate.ts";

/** A PR as the `commits/{sha}/pulls` endpoint lists it. */
export interface CommitPullRequest {
  number: number;
  node_id: string;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export type RevertDecision =
  | { action: "revert"; pr: CommitPullRequest }
  | { action: "rerun" }
  | { action: "skip"; reason: string };

export interface RevertInput {
  pr: CommitPullRequest | null;
  path: MergePath;
  /** The failed run's attempt number; 1 is the first run. */
  attempt: number;
  /** CI's result on the commit before this one, or `null` with no finished, uncancelled run. */
  parentPassed: boolean | null;
  /** Whether the bot already opened a revert, or anyone's revert was merged. */
  alreadyReverted: boolean;
}

export function decideRevert(input: RevertInput): RevertDecision {
  const { pr } = input;
  if (!pr) return { action: "skip", reason: "no merged PR made this commit" };
  if (input.path !== "auto") {
    return { action: "skip", reason: `PR #${pr.number} wasn't auto-merged` };
  }
  if (input.alreadyReverted) return { action: "skip", reason: "a revert already exists" };
  if (input.parentPassed === null) {
    return { action: "skip", reason: "no finished CI run on the parent commit to compare with" };
  }
  if (!input.parentPassed) {
    return { action: "skip", reason: "CI was already failing on the parent commit" };
  }
  if (input.attempt === 1) return { action: "rerun" };
  // A later attempt is someone re-running it by hand, likely while fixing forward.
  if (input.attempt > 2)
    return { action: "skip", reason: `attempt ${input.attempt} was started by hand` };
  return { action: "revert", pr };
}

/** The PR whose squash merge made `sha`, if there is one. */
export function mergedPrFor(prs: CommitPullRequest[], sha: string): CommitPullRequest | null {
  return prs.find((pr) => pr.merged_at && pr.merge_commit_sha === sha) ?? null;
}

export function revertBody(
  repo: string,
  pr: CommitPullRequest,
  sha: string,
  runUrl: string,
): string {
  return [
    // First, and in GitHub's own wording, so calibrate.ts counts it.
    `Reverts ${repo}#${pr.number}`,
    "",
    `CI failed on \`main\` at ${sha.slice(0, 7)} right after #${pr.number} was auto-merged, and failed again on a re-run: ${runUrl}`,
    "",
    "Merge this to get `main` green, or close it and fix forward.",
  ].join("\n");
}

export interface WorkflowRun {
  name: string;
  conclusion: string | null;
  status: string;
}

/**
 * Whether CI passed on a commit, from its runs. A cancelled run says nothing,
 * and GitHub cancels a queued run when a newer push lands, so those are left
 * out rather than read as failures.
 */
export function ciPassed(runs: WorkflowRun[]): boolean | null {
  const decided = runs.filter(
    (r) =>
      r.name === "CI" &&
      r.status === "completed" &&
      r.conclusion !== "cancelled" &&
      r.conclusion !== "skipped",
  );
  if (decided.length === 0) return null;
  return decided.some((r) => r.conclusion === "success");
}

/** Search queries for a revert that counts: one the bot opened, or one that merged. */
export function revertQueries(repo: string, prNumber: number, botSlug: string): string[] {
  const line = `repo:${repo} is:pr "Reverts ${repo}#${prNumber}" in:body`;
  return [`${line} author:app/${botSlug}`, `${line} is:merged`];
}

const REVERT_MUTATION = `mutation($id: ID!, $title: String!, $body: String!) {
  revertPullRequest(input: {pullRequestId: $id, title: $title, body: $body}) {
    revertPullRequest { number url }
  }
}`;

interface RestReview {
  state: string;
  body: string;
  author_association: string;
  user: { type: string } | null;
}

if (import.meta.main) {
  const sha = process.env.HEAD_SHA ?? "";
  const runId = process.env.RUN_ID ?? "";
  const attemptText = process.env.RUN_ATTEMPT ?? "";
  const botSlug = process.env.BOT_SLUG ?? "";
  const runUrl = process.env.RUN_URL ?? "";
  if (
    !/^[0-9a-f]{40}$/.test(sha) ||
    !/^\d+$/.test(runId) ||
    !/^[1-9]\d*$/.test(attemptText) ||
    !/^[a-z0-9-]+$/.test(botSlug)
  ) {
    throw new Error("HEAD_SHA, RUN_ID, RUN_ATTEMPT and BOT_SLUG must be set");
  }

  const repo = ghApi<{ full_name: string }>("repos/{owner}/{repo}").full_name;
  const pr = mergedPrFor(
    ghApi<CommitPullRequest[]>(`repos/{owner}/{repo}/commits/${sha}/pulls`),
    sha,
  );
  const parentSha = ghApi<{ parents: { sha: string }[] }>(`repos/{owner}/{repo}/commits/${sha}`)
    .parents[0]?.sha;

  const reviews = pr
    ? ghApiPages<RestReview>(`repos/{owner}/{repo}/pulls/${pr.number}/reviews?per_page=100`)
    : [];
  const decision = decideRevert({
    pr,
    path: mergePath(
      reviews.map((r) => ({
        state: r.state,
        body: r.body,
        byBot: r.user?.type === "Bot",
        byMaintainer: MAINTAINER_ASSOCIATIONS.includes(r.author_association),
      })),
    ),
    attempt: Number(attemptText),
    parentPassed: parentSha
      ? ciPassed(
          ghApi<{ workflow_runs: WorkflowRun[] }>(
            `repos/{owner}/{repo}/actions/runs?head_sha=${parentSha}&event=push&per_page=50`,
          ).workflow_runs,
        )
      : null,
    alreadyReverted: pr
      ? revertQueries(repo, pr.number, botSlug).some(
          (query) =>
            ghApi<{ total_count: number }>(`search/issues?q=${encodeURIComponent(query)}`)
              .total_count > 0,
        )
      : false,
  });

  if (decision.action === "skip") {
    console.log(`[verify] not reverting: ${decision.reason}`);
  } else if (decision.action === "rerun") {
    console.log("[verify] first failure after an auto-merge; re-running the failed jobs");
    run("gh", ["run", "rerun", runId, "--failed"]);
  } else {
    const reverted = decision.pr;
    const result = JSON.parse(
      run("gh", [
        "api",
        "graphql",
        "-f",
        `query=${REVERT_MUTATION}`,
        "-f",
        `id=${reverted.node_id}`,
        "-f",
        `title=Revert "${reverted.title}"`,
        "-f",
        `body=${revertBody(repo, reverted, sha, runUrl)}`,
      ]).stdout,
    );
    const revert = result.data.revertPullRequest.revertPullRequest;
    ghApi(`repos/{owner}/{repo}/issues/${reverted.number}/comments`, ["-X", "POST"], {
      body: `CI failed on \`main\` after this was auto-merged, twice. Opened #${revert.number} to revert it: ${runUrl}`,
    });
    console.log(`[verify] opened ${revert.url}`);
  }
}
