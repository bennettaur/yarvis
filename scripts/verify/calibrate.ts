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
import { ghApi, ghApiPages, run } from "./exec.ts";
import {
  APPROVE_COMMAND_PREFIX,
  AUTO_APPROVAL_PREFIX,
  type Comment,
  parseTrusted,
} from "./gate.ts";
import { parseReportData, REPORT_MARKER, type ReportData } from "./report.ts";

/** How a merged PR got its approval. */
export type MergePath = "auto" | "/approve" | "human" | "none";

export interface MergedPr {
  number: number;
  title: string;
  body: string;
  headSha: string;
}

export interface Review {
  state: string;
  body: string;
}

export interface Outcome {
  pr: MergedPr;
  /** The newest trusted report's data, or `null` if the PR had none. */
  report: ReportData | null;
  path: MergePath;
  /** PRs that reverted it or fixed a regression it caused. */
  escapedVia: number[];
}

export function mergePath(reviews: Review[]): MergePath {
  const approvals = reviews.filter((review) => review.state === "APPROVED");
  if (approvals.some((review) => review.body.startsWith(AUTO_APPROVAL_PREFIX))) return "auto";
  if (approvals.some((review) => review.body.startsWith(APPROVE_COMMAND_PREFIX))) return "/approve";
  return approvals.length > 0 ? "human" : "none";
}

/** Maps each escaped PR number to the PRs that reverted or fixed it. */
export function findEscapes(prs: MergedPr[], repo: string): Map<number, number[]> {
  const escapes = new Map<number, number[]>();
  const revert = new RegExp(
    `^Reverts ${repo.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}#(\\d+)`,
    "gm",
  );
  const regression = /^Regression-from:\s*#(\d+)\s*$/gim;
  for (const pr of prs) {
    for (const match of [...pr.body.matchAll(revert), ...pr.body.matchAll(regression)]) {
      const escaped = Number(match[1]);
      escapes.set(escaped, [...(escapes.get(escaped) ?? []), pr.number]);
    }
  }
  return escapes;
}

/** The newest report from a trusted user, with its data block parsed. */
export function latestReport(comments: Comment[], trusted: number[]): ReportData | null {
  const reports = comments.filter(
    (c) => c.body.includes(REPORT_MARKER) && trusted.includes(c.user.id),
  );
  const latest = reports[reports.length - 1];
  return latest ? parseReportData(latest.body) : null;
}

interface Row {
  merged: number;
  escaped: number;
}

function percent(part: number, whole: number): string {
  return whole === 0 ? "–" : `${Math.round((part / whole) * 100)}%`;
}

function table(title: string, rows: Map<string, Row>): string[] {
  const lines = [`### ${title}`, "", "| | Merged | Escaped | Escape rate |", "|---|---|---|---|"];
  for (const [key, row] of [...rows].sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`| ${key} | ${row.merged} | ${row.escaped} | ${percent(row.escaped, row.merged)} |`);
  }
  return [...lines, ""];
}

function tally(outcomes: Outcome[], keyOf: (outcome: Outcome) => string): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const outcome of outcomes) {
    const row = rows.get(keyOf(outcome)) ?? { merged: 0, escaped: 0 };
    row.merged++;
    if (outcome.escapedVia.length > 0) row.escaped++;
    rows.set(keyOf(outcome), row);
  }
  return rows;
}

/** A report counts only if it was for the commit that merged. */
function verdictOf(outcome: Outcome): string {
  if (!outcome.report) return "no report";
  if (outcome.report.headSha !== outcome.pr.headSha) return "stale report";
  return outcome.report.verdict;
}

export function summarize(outcomes: Outcome[], days: number): string {
  const lines = [`## Verification calibration, last ${days} days`, ""];
  lines.push(...table("By verdict", tally(outcomes, verdictOf)));
  lines.push(
    ...table(
      "By how it was approved",
      tally(outcomes, (o) => o.path),
    ),
  );
  const models = tally(
    outcomes.filter((o) => o.report?.model),
    (o) => o.report?.model ?? "",
  );
  if (models.size > 1) lines.push(...table("By reviewing model", models));

  const escaped = outcomes.filter((o) => o.escapedVia.length > 0);
  if (escaped.length > 0) {
    lines.push("### Escapes", "");
    for (const o of escaped) {
      const via = o.escapedVia.map((n) => `#${n}`).join(", ");
      lines.push(`- #${o.pr.number} ${o.pr.title}: ${verdictOf(o)}, ${o.path}, fixed by ${via}`);
    }
  }
  return lines.join("\n");
}

if (import.meta.main) {
  const { values } = parseArgs({ options: { days: { type: "string", default: "60" } } });
  const days = Number(values.days);
  if (!Number.isInteger(days) || days <= 0)
    throw new Error("--days must be a positive whole number");

  const since = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10);
  const repo = ghApi<{ full_name: string }>("repos/{owner}/{repo}").full_name;
  const trusted = parseTrusted(process.env.VERIFY_TRUSTED_USER_IDS ?? "2670128");

  const listed = JSON.parse(
    run("gh", [
      "pr",
      "list",
      "--state",
      "merged",
      "--search",
      `merged:>=${since}`,
      "--limit",
      "1000",
      "--json",
      "number,title,body,headRefOid",
    ]).stdout,
  ) as { number: number; title: string; body: string; headRefOid: string }[];
  const prs: MergedPr[] = listed.map((pr) => ({ ...pr, headSha: pr.headRefOid }));

  const escapes = findEscapes(prs, repo);
  const outcomes: Outcome[] = prs.map((pr) => ({
    pr,
    report: latestReport(
      ghApiPages<Comment>(`repos/{owner}/{repo}/issues/${pr.number}/comments?per_page=100`),
      trusted,
    ),
    path: mergePath(
      ghApiPages<Review>(`repos/{owner}/{repo}/pulls/${pr.number}/reviews?per_page=100`),
    ),
    escapedVia: escapes.get(pr.number) ?? [],
  }));
  console.log(summarize(outcomes, days));
}
