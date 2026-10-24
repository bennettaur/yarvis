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
 * text a PR author controls, so the gate takes only its verdict and its
 * assessed risk tier, and only from a report a trusted user posted and signed
 * with a key in VERIFY_ALLOWED_SIGNERS, for this PR's current commit. It
 * recomputes a floor under that tier from the PR's files and their added
 * lines, which the report's tier can raise but never lower.
 *
 * Env: GH_TOKEN (the yarvis bot's installation token), GH_REPO,
 * GITHUB_EVENT_PATH, VERIFY_MODE (`shadow` or `enforce`), VERIFY_TRUSTED_USER_IDS
 * (comma-separated numeric GitHub user IDs; IDs rather than logins, since a
 * login freed by a rename can be registered by someone else), and
 * VERIFY_ALLOWED_SIGNERS (an OpenSSH allowed_signers file).
 */

import { readFileSync } from "node:fs";
import {
  AGENT_APPROVAL_PREFIX,
  AGENT_REVIEW_MARKER,
  parseSignedAgentReview,
  reportDigest,
} from "./agentReview.ts";
import { ghApi, ghApiPages, run } from "./exec.ts";
import { parseSignedReport, REPORT_MARKER, type ReportData, type SignedReport } from "./report.ts";
import { AGENT_REVIEW_NAMESPACE, REPORT_NAMESPACE, verifiedSigner } from "./signing.ts";
import { type ChangedFile, classify, stricterTier, type Tier } from "./tier.ts";

/** The commit status the gate sets. Make it required in the ruleset once out of shadow mode. */
const STATUS_CONTEXT = "Verification report";

/**
 * How each kind of bot approval begins. `mergePath` reads them back to tell
 * how a merged PR was approved.
 */
export const AUTO_APPROVAL_PREFIX = "Auto-approved:";
export const APPROVE_COMMAND_PREFIX = "Approved by @";

/** How a merged PR got its approval. */
export type MergePath = "auto" | "agent" | "/approve" | "human" | "none";

export interface ApprovalReview {
  state: string;
  body: string;
  /**
   * Written by a GitHub App. Only apps the repo owner installed can review,
   * so this is what stops anyone else from passing off a review as the bot's.
   */
  byBot: boolean;
  /** Written by someone with write access. Anyone can approve a public PR. */
  byMaintainer: boolean;
}

/** Associations GitHub gives users with write access to the repo. */
export const MAINTAINER_ASSOCIATIONS = ["OWNER", "MEMBER", "COLLABORATOR"];

/**
 * How a merged PR was approved. A maintainer's own approval wins over the
 * bot's, since that person took the PR on whatever the bot said.
 */
export function mergePath(reviews: ApprovalReview[]): MergePath {
  const approvals = reviews.filter((review) => review.state === "APPROVED");
  if (approvals.some((review) => !review.byBot && review.byMaintainer)) return "human";
  const bot = approvals.filter((review) => review.byBot);
  if (bot.some((review) => review.body.startsWith(APPROVE_COMMAND_PREFIX))) return "/approve";
  if (bot.some((review) => review.body.startsWith(AGENT_APPROVAL_PREFIX))) return "agent";
  if (bot.some((review) => review.body.startsWith(AUTO_APPROVAL_PREFIX))) return "auto";
  return "none";
}

/**
 * How long a signed report or review counts for. A trusted account can
 * re-post an old signed comment, so without a limit one that was right once,
 * or posted in shadow mode, could be brought back to merge later. Six hours
 * covers a slow CI queue.
 */
export const MAX_SIGNED_AGE_MS = 6 * 60 * 60 * 1000;
/** Clock skew allowed between the signing machine and the runner. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** Why a signed time is outside the window the gate accepts, or `null` if it's inside. */
export function staleness(issuedAt: string, now: Date): string | null {
  const age = now.getTime() - Date.parse(issuedAt);
  if (Number.isNaN(age)) return "it has no readable signing time";
  if (age > MAX_SIGNED_AGE_MS) return `it was signed ${Math.round(age / 3_600_000)} hours ago`;
  if (age < -MAX_CLOCK_SKEW_MS) return "it was signed in the future";
  return null;
}

/** The pull request files API stops listing files here. */
const MAX_LISTED_FILES = 3000;

type Mode = "shadow" | "enforce";

export interface PullRequest {
  node_id: string;
  number: number;
  state: string;
  draft: boolean;
  changed_files: number;
  user: GitHubUser;
  head: { sha: string };
}

export interface Comment {
  id: number;
  body: string;
  html_url: string;
  user: GitHubUser;
}

export interface GitHubUser {
  login: string;
  id: number;
}

export interface AutoMergeContext {
  report: ReportData;
  prAuthor: GitHubUser;
  draft: boolean;
  trusted: number[];
  /** The tier the gate computed from the PR's files, not the report's. */
  tier: Tier;
}

/** Every reason the PR can't merge on its report alone. Empty means it can. */
export function autoMergeBlockers(ctx: AutoMergeContext): string[] {
  const reasons: string[] = [];
  if (!ctx.trusted.includes(ctx.prAuthor.id)) reasons.push("PR author is not a maintainer");
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

/** Checks a signature over a payload; injected so tests needn't make real ones. */
type SignatureCheck = (payload: string, signature: string) => boolean;

/** The principal the merge reviewer's key goes by in `VERIFY_ALLOWED_SIGNERS`. */
export const AGENT_PRINCIPAL = "yarvis-merge-reviewer";

/**
 * The two signature checks the gate makes. Each namespace is tied to its own
 * principal as well as to the `namespaces=` limit on its allowed_signers
 * line, so a line pasted without that limit still can't let the merge
 * reviewer's key sign a report, or a report key sign an approval.
 */
export function signatureChecks(allowedSigners: string): {
  isReportSigned: SignatureCheck;
  isReviewSigned: SignatureCheck;
} {
  return {
    isReportSigned: (payload, signature) => {
      const principal = verifiedSigner(payload, signature, REPORT_NAMESPACE, allowedSigners);
      return principal !== null && principal !== AGENT_PRINCIPAL;
    },
    isReviewSigned: (payload, signature) =>
      verifiedSigner(payload, signature, AGENT_REVIEW_NAMESPACE, allowedSigners) ===
      AGENT_PRINCIPAL,
  };
}

/**
 * The newest report a trusted user posted, if it is signed by an allowed key,
 * recent, and for this PR's current commit; otherwise why not. A report that
 * fails any of these sets no status: a success status on the head would
 * satisfy the required check without a current, signed report behind it.
 */
export function currentReport(input: {
  comments: Comment[];
  repo: string;
  pr: PullRequest;
  trusted: number[];
  isReportSigned: SignatureCheck;
  now: Date;
}): (SignedReport & { commentId: number }) | { skip: string } {
  const { pr } = input;
  const reports = input.comments.filter(
    (c) => c.body.includes(REPORT_MARKER) && input.trusted.includes(c.user.id),
  );
  const latest = reports[reports.length - 1];
  if (!latest) return { skip: "no report from a trusted user" };
  const signed = parseSignedReport(latest.body);
  if (!signed) return { skip: "no readable, signed data block" };
  if (!input.isReportSigned(signed.payload, signed.signature)) {
    return { skip: "the signature isn't from a key in VERIFY_ALLOWED_SIGNERS" };
  }
  const report = signed.data;
  if (report.repo !== input.repo || report.pr !== pr.number) {
    return { skip: `signed for ${report.repo}#${report.pr}, not this PR` };
  }
  const stale = staleness(report.issuedAt, input.now);
  if (stale) return { skip: `the report can't be acted on: ${stale}` };
  if (report.headSha !== pr.head.sha) {
    return {
      skip: `for ${report.headSha.slice(0, 7)}, but the head is ${pr.head.sha.slice(0, 7)}`,
    };
  }
  return { ...signed, commentId: latest.id };
}

/** What to do about a report comment, or why to do nothing. */
export function decideReport(input: {
  comment: Comment;
  comments: Comment[];
  repo: string;
  pr: PullRequest;
  files: ChangedFile[];
  trusted: number[];
  mode: Mode;
  isReportSigned: SignatureCheck;
  now: Date;
}): ReportDecision | { skip: string } {
  const { comment, pr, trusted } = input;
  if (!trusted.includes(comment.user.id)) return { skip: "posted by someone who isn't trusted" };
  const signed = currentReport(input);
  if ("skip" in signed) return signed;
  // Act only on the newest trusted report, in case an older one's run is late.
  if (signed.commentId !== comment.id) return { skip: "a newer report exists" };
  const report = signed.data;

  const reasons = autoMergeBlockers({
    report,
    prAuthor: pr.user,
    draft: pr.draft,
    trusted,
    // The report's tier rests on its assessment of what the change does; the
    // gate's own from the paths is a floor under it that the report can't lower.
    tier: stricterTier(gateTier(pr, input.files), report.riskTier),
  });
  if (reasons.length > 0) {
    return {
      status: `Report: ${report.verdict}. Not auto-merging: ${reasons.join("; ")}`,
      approve: false,
    };
  }
  if (input.mode === "shadow") {
    return { status: "Report: auto. Shadow mode, so not merging", approve: false };
  }
  return { status: "Report: auto. Approved and set to auto-merge", approve: true };
}

/**
 * What to do about the Yarvis merge reviewer's comment, or why to do
 * nothing. It can approve only a PR whose current, signed report asked for
 * an agent's review, only below high risk, and only for the exact report it
 * read: a new report needs a new review.
 *
 * Standard-risk PRs and major findings are allowed here, unlike on the
 * report's own path, because judging those is what the reviewer is for. A
 * blocker still needs a person.
 */
export function decideAgentReview(input: {
  comment: Comment;
  comments: Comment[];
  repo: string;
  pr: PullRequest;
  files: ChangedFile[];
  trusted: number[];
  mode: Mode;
  isReportSigned: SignatureCheck;
  isReviewSigned: SignatureCheck;
  now: Date;
}): ReportDecision | { skip: string } {
  const { comment, pr, trusted } = input;
  const isTrusted = (c: Comment) => trusted.includes(c.user.id);
  if (!isTrusted(comment)) return { skip: "posted by someone who isn't trusted" };
  const reviews = input.comments.filter(
    (c) => c.body.includes(AGENT_REVIEW_MARKER) && isTrusted(c),
  );
  if (reviews[reviews.length - 1]?.id !== comment.id) {
    return { skip: "a newer agent review exists" };
  }

  const review = parseSignedAgentReview(comment.body);
  if (!review) return { skip: "no readable, signed agent review" };
  if (!input.isReviewSigned(review.payload, review.signature)) {
    return { skip: "the agent review isn't signed by a key allowed for agent reviews" };
  }
  if (review.data.repo !== input.repo || review.data.pr !== pr.number) {
    return { skip: "the agent review is for another PR" };
  }
  const stale = staleness(review.data.issuedAt, input.now);
  if (stale) return { skip: `the agent review can't be acted on: ${stale}` };
  if (review.data.headSha !== pr.head.sha) {
    return { skip: "the agent review is for an older commit" };
  }

  const report = currentReport(input);
  if ("skip" in report) return report;
  const digest = reportDigest(report.payload);
  if (review.data.reportDigest !== digest) {
    return { skip: "the agent review read a different report than the latest one" };
  }
  if (report.data.verdict !== "agent") {
    return { skip: `the report's verdict is ${report.data.verdict}, not agent` };
  }
  if (review.data.decision !== "approve") {
    return { skip: `the agent review rejected it: ${review.data.reason}` };
  }
  // A signed reject of this same report stands, even if an approve was
  // re-posted after it.
  const rejected = reviews.some((c) => {
    const other = parseSignedAgentReview(c.body);
    return (
      other?.data.decision === "reject" &&
      other.data.reportDigest === digest &&
      input.isReviewSigned(other.payload, other.signature)
    );
  });
  if (rejected) return { skip: "a review of this same report rejected it" };

  const reasons: string[] = [];
  if (!trusted.includes(pr.user.id)) reasons.push("PR author is not a maintainer");
  if (pr.draft) reasons.push("PR is a draft");
  if (gateTier(pr, input.files) === "high") reasons.push("high-risk change");
  if (report.data.blockers > 0) reasons.push("report has blocker findings");
  if (reasons.length > 0) {
    return {
      status: `Report: agent, reviewed. Not auto-merging: ${reasons.join("; ")}`,
      approve: false,
    };
  }
  if (input.mode === "shadow") {
    return {
      status: "Report: agent, approved by review. Shadow mode, so not merging",
      approve: false,
    };
  }
  return { status: "Report: agent, approved by review and set to auto-merge", approve: true };
}

/** Which handler a comment goes to, or `null` for none. */
export function commentKind(body: string): "approve" | "agent-review" | "report" | null {
  if (parseApprove(body)) return "approve";
  // Checked before the report marker: a review quoting a report is still a review.
  if (body.includes(AGENT_REVIEW_MARKER)) return "agent-review";
  if (body.includes(REPORT_MARKER)) return "report";
  return null;
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
  commenter: GitHubUser;
  sha?: string;
  pr: PullRequest;
  trusted: number[];
}): string | null {
  if (!input.trusted.includes(input.commenter.id)) return "commenter is not trusted";
  const authorTrusted = input.trusted.includes(input.pr.user.id);
  if (!input.sha && !authorTrusted) {
    return "an outside contributor's PR needs `/approve <sha>` naming the commit you reviewed";
  }
  if (input.sha && !input.pr.head.sha.startsWith(input.sha)) {
    return `the head is now ${input.pr.head.sha.slice(0, 7)}, not ${input.sha.slice(0, 7)}`;
  }
  return null;
}

/** Reads the trusted user IDs, skipping anything that isn't a whole number. */
export function parseTrusted(value: string | undefined): number[] {
  return (value ?? "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d+$/.test(id))
    .map(Number);
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

/** The added lines in a file's patch, or `null` when GitHub sent none (too big, or binary). */
export function addedTextOf(patch: string | undefined): string | null {
  if (patch === undefined) return null;
  return patch
    .split("\n")
    .filter((line) => line.startsWith("+"))
    .map((line) => line.slice(1))
    .join("\n");
}

/** The PR's files, with a rename's old path so moving a file out of a high-risk path still counts. */
function changedFiles(prNumber: number): ChangedFile[] {
  return ghApiPages<{
    filename: string;
    previous_filename?: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>(`repos/{owner}/{repo}/pulls/${prNumber}/files?per_page=100`).map((file) => ({
    path: file.filename,
    previousPath: file.previous_filename,
    additions: file.additions,
    deletions: file.deletions,
    addedText: addedTextOf(file.patch),
  }));
}

function fetchPr(prNumber: number): PullRequest {
  return ghApi<PullRequest>(`repos/{owner}/{repo}/pulls/${prNumber}`);
}

function handleApprove(
  event: CommentEvent,
  pr: PullRequest,
  sha: string | undefined,
  trusted: number[],
) {
  const commenter = event.comment.user;
  const refusal = approveRefusal({ commenter, sha, pr, trusted });
  if (refusal) {
    console.log(`[verify] /approve from ${commenter.login} refused: ${refusal}`);
    react(event.comment.id, "-1");
    if (trusted.includes(commenter.id)) reply(pr.number, `Not approved: ${refusal}.`);
    return;
  }
  if (pr.draft) run("gh", ["pr", "ready", String(pr.number)]);
  approveAndMerge(
    pr,
    `${APPROVE_COMMAND_PREFIX}${commenter.login} with /approve at ${pr.head.sha.slice(0, 7)}.`,
  );
  react(event.comment.id, "rocket");
}

/**
 * Acts on a report or an agent review: reads the PR's comments and files,
 * refuses if the head moved meanwhile (the files must describe the head being
 * approved), decides, then approves and sets the status.
 */
function handleSigned(
  kind: "report" | "agent-review",
  event: CommentEvent,
  pr: PullRequest,
  trusted: number[],
  mode: Mode,
  allowedSigners: string,
) {
  const comments = ghApiPages<Comment>(
    `repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`,
  );
  const files = changedFiles(pr.number);
  if (fetchPr(pr.number).head.sha !== pr.head.sha) {
    console.log(`[verify] the head moved while reading the PR; a new ${kind} is needed`);
    return;
  }
  const input = {
    comment: event.comment,
    comments,
    repo: process.env.GH_REPO ?? "",
    pr,
    files,
    trusted,
    mode,
    ...signatureChecks(allowedSigners),
    now: new Date(),
  };
  const decision = kind === "report" ? decideReport(input) : decideAgentReview(input);
  if ("skip" in decision) {
    console.log(`[verify] ignoring this ${kind}: ${decision.skip}`);
    return;
  }
  if (decision.approve) {
    const head = pr.head.sha.slice(0, 7);
    approveAndMerge(
      pr,
      kind === "report"
        ? `${AUTO_APPROVAL_PREFIX} the verification report for ${head} passed.`
        : `${AGENT_APPROVAL_PREFIX} the merge reviewer approved ${head} after its verification report asked for a review.`,
    );
  }
  setStatus(pr.head.sha, decision.status, event.comment.html_url);
}

if (import.meta.main) {
  const event = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8"),
  ) as CommentEvent;
  if (!event.issue.pull_request) process.exit(0);

  const trusted = parseTrusted(process.env.VERIFY_TRUSTED_USER_IDS);
  if (trusted.length === 0) {
    console.warn("[verify] VERIFY_TRUSTED_USER_IDS has no numeric IDs, so nobody is trusted");
  }
  const mode: Mode = process.env.VERIFY_MODE === "enforce" ? "enforce" : "shadow";
  const allowedSigners = process.env.VERIFY_ALLOWED_SIGNERS ?? "";
  if (!allowedSigners.trim()) {
    console.warn("[verify] VERIFY_ALLOWED_SIGNERS is empty, so no report can be accepted");
  }
  const pr = fetchPr(event.issue.number);
  if (pr.state !== "open") process.exit(0);

  const kind = commentKind(event.comment.body);
  if (kind === "approve") {
    handleApprove(event, pr, parseApprove(event.comment.body)?.sha, trusted);
  } else if (kind) {
    handleSigned(kind, event, pr, trusted, mode, allowedSigners);
  }
}
