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
 * Env: GH_TOKEN (the yarvis bot's installation token), GH_REPO,
 * GITHUB_EVENT_PATH, VERIFY_MODE (`shadow` or `enforce`), VERIFY_TRUSTED_USERS
 * (comma-separated logins).
 */

import { readFileSync } from "node:fs";
import { ghApi, ghApiPages, run } from "./exec.ts";
import { parseReportData, REPORT_MARKER, type ReportData } from "./report.ts";
import { type ChangedFile, classify, type Tier } from "./tier.ts";

/** The commit status the gate sets. Make it required in the ruleset once out of shadow mode. */
const STATUS_CONTEXT = "Verification report";

/** The pull request files API stops listing files here. */
const MAX_LISTED_FILES = 3000;

type Mode = "shadow" | "enforce";

export interface PullRequest {
  node_id: string;
  number: number;
  state: string;
  draft: boolean;
  changed_files: number;
  user: { login: string };
  head: { sha: string };
}

export interface Comment {
  id: number;
  body: string;
  html_url: string;
  user: { login: string };
}

export interface AutoMergeContext {
  report: ReportData;
  prAuthor: string;
  draft: boolean;
  trusted: string[];
  /** The tier the gate computed from the PR's files, not the report's. */
  tier: Tier;
}

/** Every reason the PR can't merge on its report alone. Empty means it can. */
export function autoMergeBlockers(ctx: AutoMergeContext): string[] {
  const reasons: string[] = [];
  if (!ctx.trusted.includes(ctx.prAuthor)) reasons.push("PR author is not a maintainer");
  if (ctx.draft) reasons.push("PR is a draft");
  if (ctx.tier !== "low") reasons.push(`${ctx.tier}-risk change`);
  if (ctx.report.verdict !== "auto") reasons.push(`verdict is ${ctx.report.verdict}`);
  if (ctx.report.blockers > 0 || ctx.report.majors > 0) {
    reasons.push("report has blocker or major findings");
  }
  if (ctx.report.flagged.length > 0) reasons.push(`flagged: ${ctx.report.flagged.join(", ")}`);
  return reasons;
}

/**
 * The gate's own tier for the PR. A file list cut short at the API's limit
 * could be hiding a high-risk file, so it counts as high.
 */
export function gateTier(pr: PullRequest, files: ChangedFile[]): Tier {
  if (files.length >= MAX_LISTED_FILES || files.length < pr.changed_files) return "high";
  return classify(files).tier;
}

export interface ReportDecision {
  status: string;
  approve: boolean;
}

/**
 * What to do about a report comment, or `null` to do nothing. A report for an
 * older commit sets no status at all, since a success status on the new head
 * would satisfy the required check without a report for it.
 */
export function decideReport(input: {
  comment: Comment;
  comments: Comment[];
  pr: PullRequest;
  files: ChangedFile[];
  trusted: string[];
  mode: Mode;
}): ReportDecision | null {
  const { comment, pr, trusted } = input;
  const isTrusted = (c: Comment) => trusted.includes(c.user.login.toLowerCase());
  if (!isTrusted(comment)) return null;

  // Act only on the newest trusted report, in case an older one's run is late.
  const reports = input.comments.filter((c) => c.body.includes(REPORT_MARKER) && isTrusted(c));
  if (reports[reports.length - 1]?.id !== comment.id) return null;

  const report = parseReportData(comment.body);
  if (!report || report.headSha !== pr.head.sha) return null;

  const blockers = autoMergeBlockers({
    report,
    prAuthor: pr.user.login.toLowerCase(),
    draft: pr.draft,
    trusted,
    tier: gateTier(pr, input.files),
  });
  if (blockers.length > 0) {
    return {
      status: `Report: ${report.verdict}. Not auto-merging: ${blockers.join("; ")}`,
      approve: false,
    };
  }
  if (input.mode === "shadow") {
    return { status: "Report: auto. Shadow mode, so not merging", approve: false };
  }
  return { status: "Report: auto. Approved and set to auto-merge", approve: true };
}

/** Reads `/approve`, or `/approve <sha>` naming the commit the maintainer reviewed. */
export function parseApprove(body: string): { sha?: string } | null {
  const match = body.trim().match(/^\/approve(?:\s+([0-9a-f]{7,40}))?$/i);
  if (!match) return null;
  return match[1] ? { sha: match[1].toLowerCase() } : {};
}

/**
 * Why an `/approve` can't go ahead, or `null` if it can. On an outside
 * contributor's PR it must name the reviewed commit: they could push between
 * the maintainer reading the diff and this job running.
 */
export function approveRefusal(input: {
  commenter: string;
  sha?: string;
  pr: PullRequest;
  trusted: string[];
}): string | null {
  if (!input.trusted.includes(input.commenter.toLowerCase())) return "commenter is not trusted";
  const authorTrusted = input.trusted.includes(input.pr.user.login.toLowerCase());
  if (!input.sha && !authorTrusted) {
    return "an outside contributor's PR needs `/approve <sha>` naming the commit you reviewed";
  }
  if (input.sha && !input.pr.head.sha.startsWith(input.sha)) {
    return `the head is now ${input.pr.head.sha.slice(0, 7)}, not ${input.sha.slice(0, 7)}`;
  }
  return null;
}

export function parseTrusted(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((login) => login.trim().toLowerCase())
    .filter(Boolean);
}

interface CommentEvent {
  issue: { number: number; pull_request?: unknown };
  comment: Comment;
}

function react(commentId: number, content: "-1" | "rocket") {
  ghApi(`repos/{owner}/{repo}/issues/comments/${commentId}/reactions`, ["-X", "POST"], { content });
}

function reply(prNumber: number, body: string) {
  ghApi(`repos/{owner}/{repo}/issues/${prNumber}/comments`, ["-X", "POST"], { body });
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

const AUTO_MERGE_MUTATION = `mutation($id: ID!, $sha: GitObjectID!) {
  enablePullRequestAutoMerge(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $sha}) { clientMutationId }
}`;
const MERGE_MUTATION = `mutation($id: ID!, $sha: GitObjectID!) {
  mergePullRequest(input: {pullRequestId: $id, mergeMethod: SQUASH, expectedHeadOid: $sha}) { clientMutationId }
}`;

function graphql(query: string, pr: PullRequest, allowFailure = false) {
  return run(
    "gh",
    [
      "api",
      "graphql",
      "-f",
      `query=${query}`,
      "-f",
      `id=${pr.node_id}`,
      "-f",
      `sha=${pr.head.sha}`,
    ],
    { allowFailure },
  );
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
  const auto = graphql(AUTO_MERGE_MUTATION, pr, true);
  // GitHub refuses auto-merge on a PR with nothing left to wait for; merge it now instead.
  if (auto.status !== 0 && /clean status/i.test(auto.stdout + auto.stderr)) {
    graphql(MERGE_MUTATION, pr);
  } else if (auto.status !== 0) {
    throw new Error(`enabling auto-merge failed: ${auto.stdout} ${auto.stderr}`.trim());
  }
}

/** Both sides of a rename, so moving a file out of a high-risk path still counts. */
function changedFiles(prNumber: number): ChangedFile[] {
  return ghApiPages<{
    filename: string;
    previous_filename?: string;
    additions: number;
    deletions: number;
  }>(`repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`).map((file) => ({
    path: file.filename,
    previousPath: file.previous_filename,
    additions: file.additions,
    deletions: file.deletions,
  }));
}

function fetchPr(prNumber: number): PullRequest {
  return ghApi<PullRequest>(`repos/{owner}/{repo}/pulls/${prNumber}`);
}

function handleApprove(
  event: CommentEvent,
  pr: PullRequest,
  sha: string | undefined,
  trusted: string[],
) {
  const commenter = event.comment.user.login;
  const refusal = approveRefusal({ commenter, sha, pr, trusted });
  if (refusal) {
    console.log(`[verify] /approve from ${commenter} refused: ${refusal}`);
    react(event.comment.id, "-1");
    if (trusted.includes(commenter.toLowerCase())) reply(pr.number, `Not approved: ${refusal}.`);
    return;
  }
  if (pr.draft) run("gh", ["pr", "ready", String(pr.number)]);
  approveAndMerge(pr, `Approved by @${commenter} with /approve at ${pr.head.sha.slice(0, 7)}.`);
  react(event.comment.id, "rocket");
}

function handleReport(event: CommentEvent, pr: PullRequest, trusted: string[], mode: Mode) {
  const comments = ghApiPages<Comment>(
    `repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`,
  );
  const files = changedFiles(pr.number);
  // The files must describe the head being approved, so refuse if it moved meanwhile.
  if (fetchPr(pr.number).head.sha !== pr.head.sha) {
    console.log("[verify] the head moved while reading the PR; a new report is needed");
    return;
  }
  const decision = decideReport({ comment: event.comment, comments, pr, files, trusted, mode });
  if (!decision) {
    console.log("[verify] not the newest current trusted report; nothing to do");
    return;
  }
  if (decision.approve) {
    approveAndMerge(
      pr,
      `Auto-approved: the verification report for ${pr.head.sha.slice(0, 7)} passed.`,
    );
  }
  setStatus(pr.head.sha, decision.status, event.comment.html_url);
}

if (import.meta.main) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  ) as CommentEvent;
  if (!event.issue.pull_request) process.exit(0);

  const trusted = parseTrusted(process.env.VERIFY_TRUSTED_USERS);
  const mode: Mode = process.env.VERIFY_MODE === "enforce" ? "enforce" : "shadow";
  const pr = fetchPr(event.issue.number);
  if (pr.state !== "open") process.exit(0);

  const approve = parseApprove(event.comment.body);
  if (approve) {
    handleApprove(event, pr, approve.sha, trusted);
  } else if (event.comment.body.includes(REPORT_MARKER)) {
    handleReport(event, pr, trusted, mode);
  }
}
