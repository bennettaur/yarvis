#!/usr/bin/env bun
/**
 * The CI half of the verification layer, run by `.github/workflows/verify.yml`
 * on a pull request comment. It handles two kinds:
 *
 * - `/approve` from a trusted user: the yarvis bot approves the PR's current
 *   head and turns on auto-merge. This is how a maintainer merges a PR they
 *   opened, since GitHub won't let them approve their own.
 * - A verification report: the gate sets a commit status saying a current
 *   report exists, and when the report allows it, approves and turns on
 *   auto-merge the same way.
 *
 * Everything here is deterministic. The report was written by a model reading
 * text a PR author controls, so the gate takes nothing from it on trust except
 * the verdict, and only from a report a trusted user posted. It recomputes the
 * risk tier itself from the PR's files.
 *
 * Env: GH_TOKEN (the yarvis bot's installation token), GITHUB_EVENT_PATH,
 * GITHUB_REPOSITORY, VERIFY_MODE (`shadow` or `enforce`), VERIFY_TRUSTED_USERS
 * (comma-separated logins).
 */

import { readFileSync } from "node:fs";
import { ghApi, ghApiPages, run } from "./exec.ts";
import { parseReportData, REPORT_MARKER, type ReportData } from "./report.ts";
import { type ChangedFile, classify, type Tier } from "./tier.ts";

/** The commit status the gate sets. Make it required in the ruleset once out of shadow mode. */
export const STATUS_CONTEXT = "Verification report";

export type Mode = "shadow" | "enforce";

export interface AutoMergeContext {
  data: ReportData;
  headSha: string;
  prAuthor: string;
  draft: boolean;
  trusted: string[];
  /** The tier the gate computed from the PR's files, not the report's. */
  tier: Tier;
}

/** Every reason the PR can't merge on its report alone. Empty means it can. */
export function autoMergeBlockers(ctx: AutoMergeContext): string[] {
  const reasons: string[] = [];
  if (ctx.data.headSha !== ctx.headSha) reasons.push("report is for an older commit");
  if (!ctx.trusted.includes(ctx.prAuthor)) reasons.push("PR author is not a maintainer");
  if (ctx.draft) reasons.push("PR is a draft");
  if (ctx.tier !== "low") reasons.push(`${ctx.tier}-risk change`);
  if (ctx.data.verdict !== "auto") reasons.push(`verdict is ${ctx.data.verdict}`);
  if (ctx.data.blockers > 0 || ctx.data.majors > 0) reasons.push("report has major findings");
  if (ctx.data.failing.length > 0) reasons.push(`concerns: ${ctx.data.failing.join(", ")}`);
  return reasons;
}

export function isApproveCommand(body: string): boolean {
  return /^\/approve\s*$/.test(body.trim());
}

export function parseTrusted(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
}

interface PullRequest {
  node_id: string;
  number: number;
  state: string;
  draft: boolean;
  user: { login: string };
  head: { sha: string };
  html_url: string;
}

interface Comment {
  id: number;
  body: string;
  html_url: string;
  created_at: string;
  user: { login: string };
}

interface CommentEvent {
  issue: { number: number; pull_request?: unknown };
  comment: Comment;
}

function react(commentId: number, content: "+1" | "-1" | "rocket" | "eyes") {
  ghApi(`repos/{owner}/{repo}/issues/comments/${commentId}/reactions`, ["-X", "POST"], { content });
}

function setStatus(sha: string, description: string, targetUrl: string) {
  ghApi(`repos/{owner}/{repo}/statuses/${sha}`, ["-X", "POST"], {
    state: "success",
    context: STATUS_CONTEXT,
    // GitHub rejects a description over 140 characters.
    description: description.slice(0, 140),
    target_url: targetUrl,
  });
}

/**
 * Approves the given head and turns on squash auto-merge pinned to it, so a
 * commit pushed afterwards can't ride along on this approval.
 */
function approveAndMerge(pr: PullRequest, reason: string) {
  ghApi(`repos/{owner}/{repo}/pulls/${pr.number}/reviews`, ["-X", "POST"], {
    commit_id: pr.head.sha,
    event: "APPROVE",
    body: reason,
  });
  run("gh", [
    "api",
    "graphql",
    "-f",
    "query=mutation($id: ID!, $sha: GitObjectID!) { enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $sha}) { clientMutationId } }",
    "-f",
    `id=${pr.node_id}`,
    "-f",
    `sha=${pr.head.sha}`,
  ]);
}

function changedFiles(prNumber: number): ChangedFile[] {
  return ghApiPages<{ filename: string; additions: number; deletions: number }>(
    `repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`,
  ).map((file) => ({ path: file.filename, additions: file.additions, deletions: file.deletions }));
}

function handleApprove(event: CommentEvent, pr: PullRequest, trusted: string[]) {
  const login = event.comment.user.login.toLowerCase();
  if (!trusted.includes(login)) {
    console.log(`[verify] /approve from ${login}, who is not trusted; ignoring`);
    react(event.comment.id, "-1");
    return;
  }
  if (pr.draft) {
    run("gh", ["pr", "ready", String(pr.number)]);
  }
  approveAndMerge(pr, `Approved by @${login} with /approve at ${pr.head.sha.slice(0, 7)}.`);
  react(event.comment.id, "rocket");
}

function handleReport(event: CommentEvent, pr: PullRequest, trusted: string[], mode: Mode) {
  const author = event.comment.user.login.toLowerCase();
  if (!trusted.includes(author)) {
    console.log(`[verify] report posted by ${author}, who is not trusted; ignoring`);
    return;
  }

  // Act only on the newest trusted report, in case an older one's run is late.
  const reports = ghApiPages<Comment>(`repos/{owner}/{repo}/issues/${pr.number}/comments`).filter(
    (c) => c.body.includes(REPORT_MARKER) && trusted.includes(c.user.login.toLowerCase()),
  );
  const latest = reports[reports.length - 1];
  if (!latest || latest.id !== event.comment.id) {
    console.log("[verify] a newer report exists; leaving it to that run");
    return;
  }

  const data = parseReportData(latest.body);
  if (!data) {
    console.log("[verify] report has no readable data block; ignoring");
    return;
  }
  if (data.headSha !== pr.head.sha) {
    console.log(
      `[verify] report is for ${data.headSha.slice(0, 7)}, head is ${pr.head.sha.slice(0, 7)}`,
    );
    return;
  }

  const tier = classify(changedFiles(pr.number)).tier;
  const blockers = autoMergeBlockers({
    data,
    headSha: pr.head.sha,
    prAuthor: pr.user.login.toLowerCase(),
    draft: pr.draft,
    trusted,
    tier,
  });

  if (blockers.length > 0) {
    setStatus(
      pr.head.sha,
      `Report: ${data.verdict}. Not auto-merging: ${blockers.join("; ")}`,
      latest.html_url,
    );
    return;
  }
  if (mode === "shadow") {
    setStatus(pr.head.sha, "Report: auto. Shadow mode, so not merging", latest.html_url);
    return;
  }
  setStatus(pr.head.sha, "Report: auto. Approved and set to auto-merge", latest.html_url);
  approveAndMerge(
    pr,
    `Auto-approved: the verification report for ${pr.head.sha.slice(0, 7)} passed.`,
  );
}

if (import.meta.main) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  ) as CommentEvent;
  if (!event.issue.pull_request) process.exit(0);

  const trusted = parseTrusted(process.env.VERIFY_TRUSTED_USERS);
  const mode: Mode = process.env.VERIFY_MODE === "enforce" ? "enforce" : "shadow";
  const pr = ghApi<PullRequest>(`repos/{owner}/{repo}/pulls/${event.issue.number}`);
  if (pr.state !== "open") process.exit(0);

  if (isApproveCommand(event.comment.body)) {
    handleApprove(event, pr, trusted);
  } else if (event.comment.body.includes(REPORT_MARKER)) {
    handleReport(event, pr, trusted, mode);
  }
}
