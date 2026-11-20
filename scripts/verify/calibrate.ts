#!/usr/bin/env bun
/**
 * Checks how well past verification verdicts held up. For each PR merged in
 * the window it reads the verdict its last trusted report gave and how it was
 * approved, then counts the ones a later PR reverted or fixed as a
 * regression. A verdict tier with escapes is a sign its thresholds are too
 * loose; one with none over many merges is a candidate for loosening.
 *
 *   bun run verify:calibrate [--days 60]
 *
 * An escape is a merged PR whose body has GitHub's revert line
 * (`Reverts owner/repo#123`) or a `Regression-from: #123` line, which fix PRs
 * add by hand. GitHub is the record, so nothing here is stored.
 */

import { parseArgs } from "node:util";
import { run } from "./exec.ts";
import {
  type ApprovalReview,
  MAINTAINER_ASSOCIATIONS,
  type MergePath,
  mergePath,
  parseTrusted,
} from "./gate.ts";
import { parseSignedReport, REPORT_MARKER, type ReportData } from "./report.ts";

export interface MergedPr {
  number: number;
  title: string;
  body: string;
  headSha: string;
}

export interface Outcome {
  pr: MergedPr;
  /** The newest trusted report's data, or `null` if the PR had none. */
  report: ReportData | null;
  path: MergePath;
  /** PRs that reverted it or fixed a regression it caused. */
  escapedVia: number[];
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

/** Maps each escaped PR number to the PRs that reverted or fixed it. */
export function findEscapes(prs: MergedPr[], repo: string): Map<number, number[]> {
  const escapes = new Map<number, number[]>();
  const revert = new RegExp(`^Reverts ${escapeRegExp(repo)}#(\\d+)`, "gm");
  const regression = /^Regression-from:\s*#(\d+)\s*$/gim;
  for (const pr of prs) {
    for (const match of [...pr.body.matchAll(revert), ...pr.body.matchAll(regression)]) {
      const escaped = Number(match[1]);
      const via = escapes.get(escaped) ?? [];
      // A fix PR can both revert and name the regression; count it once.
      if (!via.includes(pr.number)) escapes.set(escaped, [...via, pr.number]);
    }
  }
  return escapes;
}

export interface ReportComment {
  body: string;
  /** The author's numeric user ID, or `null` for a bot or app, which never count as trusted. */
  authorId: number | null;
}

/** The newest report from a trusted user, with its data block parsed. */
export function latestReport(comments: ReportComment[], trusted: number[]): ReportData | null {
  const reports = comments.filter(
    (c) => c.body.includes(REPORT_MARKER) && c.authorId !== null && trusted.includes(c.authorId),
  );
  const latest = reports[reports.length - 1];
  return latest ? (parseSignedReport(latest.body)?.data ?? null) : null;
}

interface Tally {
  merged: number;
  escaped: number;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

function table(title: string, tallies: Map<string, Tally>): string[] {
  const lines = [`### ${title}`, "", "| | Merged | Escaped | Escape rate |", "|---|---|---|---|"];
  for (const [key, t] of [...tallies].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${key} | ${t.merged} | ${t.escaped} | ${percent(t.escaped, t.merged)} |`);
  }
  return [...lines, ""];
}

function tally<T extends Outcome>(
  outcomes: T[],
  keyOf: (outcome: T) => string,
): Map<string, Tally> {
  const tallies = new Map<string, Tally>();
  for (const outcome of outcomes) {
    const t = tallies.get(keyOf(outcome)) ?? { merged: 0, escaped: 0 };
    t.merged++;
    if (outcome.escapedVia.length > 0) t.escaped++;
    tallies.set(keyOf(outcome), t);
  }
  return tallies;
}

/** A report counts only if it was for the commit that merged. */
function verdictOf(outcome: Outcome): string {
  if (!outcome.report) return "no report";
  if (outcome.report.headSha !== outcome.pr.headSha) return "stale report";
  return outcome.report.verdict;
}

/**
 * The tables, leaving out the reverts and fixes themselves: they are the
 * outcome being measured, and counting them as merges would dilute the rows
 * they land in.
 */
export function summarize(outcomes: Outcome[], days: number): string {
  const fixers = new Set(outcomes.flatMap((o) => o.escapedVia));
  const measured = outcomes.filter((o) => !fixers.has(o.pr.number));

  const lines = [`## Verification calibration, last ${days} days`, ""];
  lines.push(...table("By verdict", tally(measured, verdictOf)));
  // Escapes in a tier the assessment called low are the ones to watch: they
  // mean the assessment, not the floor, let a risky change through.
  lines.push(
    ...table(
      "By risk tier",
      tally(measured, (o) =>
        verdictOf(o) === o.report?.verdict ? o.report.riskTier : verdictOf(o),
      ),
    ),
  );
  lines.push(
    ...table(
      "By how it was approved",
      tally(measured, (o) => o.path),
    ),
  );
  const withModel = measured.flatMap((o) =>
    o.report?.model ? [{ ...o, model: o.report.model }] : [],
  );
  const models = tally(withModel, (o) => o.model);
  if (models.size > 1) lines.push(...table("By reviewing model", models));

  const escaped = measured.filter((o) => o.escapedVia.length > 0);
  if (escaped.length > 0) {
    lines.push("### Escapes", "");
    for (const o of escaped) {
      const via = o.escapedVia.map((n) => `#${n}`).join(", ");
      lines.push(`- #${o.pr.number} ${o.pr.title}: ${verdictOf(o)}, ${o.path}, fixed by ${via}`);
    }
  }
  return lines.join("\n");
}

const MERGED_PRS_QUERY = `query($q: String!, $endCursor: String) {
  search(query: $q, type: ISSUE, first: 50, after: $endCursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        body
        headRefOid
        # Each verify run posts a fresh report comment, so the latest report
        # is among the last 100 comments.
        comments(last: 100) { nodes { body author { ... on User { databaseId } } } }
        reviews(last: 100) { nodes { state body authorAssociation author { __typename } } }
      }
    }
  }
}`;

interface SearchNode {
  number: number;
  title: string;
  body: string;
  headRefOid: string;
  comments: { nodes: { body: string; author: { databaseId?: number } | null }[] };
  reviews: {
    nodes: {
      state: string;
      body: string;
      authorAssociation: string;
      author: { __typename: string } | null;
    }[];
  };
}

export function outcomeFor(node: SearchNode, trusted: number[], escapedVia: number[]): Outcome {
  return {
    pr: { number: node.number, title: node.title, body: node.body, headSha: node.headRefOid },
    report: latestReport(
      node.comments.nodes.map((c) => ({ body: c.body, authorId: c.author?.databaseId ?? null })),
      trusted,
    ),
    path: mergePath(
      node.reviews.nodes.map(
        (r): ApprovalReview => ({
          state: r.state,
          body: r.body,
          byBot: r.author?.__typename === "Bot",
          byMaintainer: MAINTAINER_ASSOCIATIONS.includes(r.authorAssociation),
        }),
      ),
    ),
    escapedVia,
  };
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: "string", default: "60" } } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days <= 0)
    throw new Error("--days must be a positive whole number");

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const repo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).stdout.trim();
  // The workflow's default trusted list, for running this locally without the variable.
  const trusted = parseTrusted(process.env.VERIFY_TRUSTED_USER_IDS ?? "2670128");

  // One query per 50 PRs, with their comments and reviews, rather than two
  // REST calls per PR: a long window would otherwise eat the rate limit.
  const pages = JSON.parse(
    run("gh", [
      "api",
      "graphql",
      "--paginate",
      "--slurp",
      "-f",
      `query=${MERGED_PRS_QUERY}`,
      "-f",
      `q=repo:${repo} is:pr is:merged merged:>=${since}`,
    ]).stdout,
  ) as { data: { search: { nodes: SearchNode[] } } }[];
  const nodes = pages.flatMap((page) => page.data.search.nodes);

  const escapes = findEscapes(
    nodes.map((node) => ({ ...node, headSha: node.headRefOid })),
    repo,
  );
  const outcomes = nodes.map((node) => outcomeFor(node, trusted, escapes.get(node.number) ?? []));
  console.log(summarize(outcomes, days));
}
