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
 * Env: GH_TOKEN (the yarvis bot's installation token), GH_REPO, HEAD_SHA (the
 * commit CI failed on), RUN_ID and RUN_ATTEMPT (the failed CI run), RUN_URL.
 */

import { type MergePath, mergePath, type Review } from "./calibrate.ts";
import { ghApi, ghApiPages, run } from "./exec.ts";

export interface MergedPr {
  number: number;
  node_id: string;
  title: string;
  merged_at: string | null;
  merge_commit_sha: string | null;
}

export type RevertDecision =
  | { action: "revert" }
  | { action: "rerun" }
  | { action: "skip"; reason: string };

/**
 * @param attempt the failed run's attempt number; 1 is the first run.
 * @param parentPassed whether CI passed on the commit before this one, or
 *   `null` when there is no finished run for it.
 * @param alreadyReverted whether an open or merged PR already reverts it.
 */
export function decideRevert(input: {
  pr: MergedPr | null;
  path: MergePath;
  attempt: number;
  parentPassed: boolean | null;
  alreadyReverted: boolean;
}): RevertDecision {
  if (!input.pr) return { action: "skip", reason: "no merged PR made this commit" };
  if (input.path !== "auto") {
    return { action: "skip", reason: `PR #${input.pr.number} was approved by a person` };
  }
  if (input.alreadyReverted) return { action: "skip", reason: "a revert already exists" };
  if (input.parentPassed !== true) {
    return { action: "skip", reason: "CI wasn't passing on the parent commit either" };
  }
  if (input.attempt < 2) return { action: "rerun" };
  return { action: "revert" };
}

/** The PR whose squash merge made `sha`, if there is one. */
export function mergedPrFor(prs: MergedPr[], sha: string): MergedPr | null {
  return prs.find((pr) => pr.merged_at && pr.merge_commit_sha === sha) ?? null;
}

export function revertBody(repo: string, pr: MergedPr, sha: string, runUrl: string): string {
  return [
    // First, and in GitHub's own wording, so calibrate.ts counts it.
    `Reverts ${repo}#${pr.number}`,
    "",
    `CI failed on \`main\` at ${sha.slice(0, 7)} right after #${pr.number} was auto-merged, and failed again on a re-run: ${runUrl}`,
    "",
    "Merge this to get `main` green, or close it and fix forward.",
  ].join("\n");
}

interface WorkflowRun {
  name: string;
  conclusion: string | null;
  status: string;
}

/** Whether CI passed on `sha`, or `null` if it has no finished CI run. */
function ciPassed(sha: string): boolean | null {
  const { workflow_runs: runs } = ghApi<{ workflow_runs: WorkflowRun[] }>(
    `repos/{owner}/{repo}/actions/runs?head_sha=${sha}&event=push&per_page=50`,
  );
  const ci = runs.filter((r) => r.name === "CI" && r.status === "completed");
  if (ci.length === 0) return null;
  return ci.some((r) => r.conclusion === "success");
}

function alreadyReverted(repo: string, number: number): boolean {
  const query = `repo:${repo} is:pr "Reverts ${repo}#${number}" in:body`;
  const { total_count } = ghApi<{ total_count: number }>(
    `search/issues?q=${encodeURIComponent(query)}`,
  );
  return total_count > 0;
}

const REVERT_MUTATION = `mutation($id: ID!, $title: String!, $body: String!) {
  revertPullRequest(input: {pullRequestId: $id, title: $title, body: $body}) {
    revertPullRequest { number url }
  }
}`;

if (import.meta.main) {
  const sha = process.env.HEAD_SHA ?? "";
  const runId = process.env.RUN_ID ?? "";
  const attempt = Number(process.env.RUN_ATTEMPT ?? "1");
  const runUrl = process.env.RUN_URL ?? "";
  if (!/^[0-9a-f]{40}$/.test(sha) || !/^\d+$/.test(runId)) {
    throw new Error("HEAD_SHA and RUN_ID must be set");
  }

  const repo = ghApi<{ full_name: string }>("repos/{owner}/{repo}").full_name;
  const pr = mergedPrFor(ghApi<MergedPr[]>(`repos/{owner}/{repo}/commits/${sha}/pulls`), sha);
  const parent = ghApi<{ parents: { sha: string }[] }>(`repos/{owner}/{repo}/commits/${sha}`)
    .parents[0]?.sha;

  const decision = decideRevert({
    pr,
    path: pr
      ? mergePath(
          ghApiPages<Review>(`repos/{owner}/{repo}/pulls/${pr.number}/reviews?per_page=100`),
        )
      : "none",
    attempt,
    parentPassed: parent ? ciPassed(parent) : null,
    alreadyReverted: pr ? alreadyReverted(repo, pr.number) : false,
  });

  if (decision.action === "skip") {
    console.log(`[verify] not reverting: ${decision.reason}`);
  } else if (decision.action === "rerun") {
    console.log("[verify] first failure after an auto-merge; re-running the failed jobs");
    run("gh", ["run", "rerun", runId, "--failed"]);
  } else if (pr) {
    const result = JSON.parse(
      run("gh", [
        "api",
        "graphql",
        "-f",
        `query=${REVERT_MUTATION}`,
        "-f",
        `id=${pr.node_id}`,
        "-f",
        `title=Revert "${pr.title}"`,
        "-f",
        `body=${revertBody(repo, pr, sha, runUrl)}`,
      ]).stdout,
    );
    const revert = result.data.revertPullRequest.revertPullRequest;
    ghApi(`repos/{owner}/{repo}/issues/${pr.number}/comments`, ["-X", "POST"], {
      body: `CI failed on \`main\` after this was auto-merged, twice. Opened #${revert.number} to revert it: ${runUrl}`,
    });
    console.log(`[verify] opened ${revert.url}`);
  }
}
