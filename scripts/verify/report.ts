#!/usr/bin/env bun
/**
 * Renders a verification report and posts it on the pull request, replacing
 * the previous one. The review half comes from the `/verify-pr` skill as JSON;
 * the measured half comes from `collect.ts`. The length limits in the schema
 * are what keep the report shorter to read than the PR.
 *
 *   bun run verify:report --pr 123 --review review.json --facts facts.json [--dry-run]
 */

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Facts } from "./collect.ts";
import { ghApi, ghApiPages, run } from "./exec.ts";
import type { Tier } from "./tier.ts";

/** Marks a comment as a verification report. The gate looks for it. */
export const REPORT_MARKER = "<!-- yarvis-verify -->";
const DATA_PATTERN = /<!-- yarvis-verify-data ([A-Za-z0-9+/=]+) -->/;

/** Changed-line coverage at or above this passes; below the floor fails. */
export const COVERAGE_PASS = 0.8;
export const COVERAGE_FLOOR = 0.5;

const Status = z.enum(["pass", "concern", "fail", "n/a"]);
type Status = z.infer<typeof Status>;

const Verdict = z.enum(["auto", "agent", "human"]);
export type Verdict = z.infer<typeof Verdict>;

const Dimension = z.object({ status: Status, note: z.string().max(140) });

export const Review = z.object({
  /** What the PR is meant to achieve, in one line, taken from its description or issue. */
  goal: z.string().min(1).max(200),
  summary: z.string().min(1).max(300),
  verdict: Verdict,
  verdictReason: z.string().max(200),
  dimensions: z.object({
    goal: Dimension,
    tests: Dimension,
    reliability: Dimension,
    security: Dimension,
    complexity: Dimension,
    maintainability: Dimension,
    ui: Dimension,
  }),
  findings: z
    .array(
      z.object({
        severity: z.enum(["blocker", "major", "minor"]),
        title: z.string().max(120),
        location: z.string().max(120).optional(),
        detail: z.string().max(400),
      }),
    )
    .max(10),
  screenshots: z
    .array(z.object({ path: z.string(), caption: z.string().max(120) }))
    .max(10)
    .default([]),
  /** The review agents that ran, and the model behind them, so reports stay comparable. */
  reviewers: z.array(z.string()).max(12),
  model: z.string().max(60),
});
export type Review = z.infer<typeof Review>;

/** What the gate reads back out of a posted report. */
export interface ReportData {
  version: 1;
  headSha: string;
  verdict: Verdict;
  tier: Tier;
  blockers: number;
  majors: number;
  /** Dimensions, including coverage, whose status is `fail` or `concern`. */
  failing: string[];
  coverage: number | null;
}

export function coverageStatus(coverage: Facts["coverage"]): Status {
  if (coverage.ratio === null && coverage.notLoaded.length === 0) return "n/a";
  if (coverage.notLoaded.length > 0) return coverage.ratio === null ? "fail" : "concern";
  const ratio = coverage.ratio ?? 0;
  if (ratio >= COVERAGE_PASS) return "pass";
  return ratio >= COVERAGE_FLOOR ? "concern" : "fail";
}

/**
 * The verdict a report may give, which is never looser than the risk tier
 * allows. Only a low-risk PR with nothing wrong is eligible to merge on its own.
 */
export function finalVerdict(review: Review, facts: Facts): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  let verdict = review.verdict;
  const cap = (to: Verdict, reason: string) => {
    const order: Verdict[] = ["auto", "agent", "human"];
    if (order.indexOf(to) > order.indexOf(verdict)) {
      verdict = to;
      why.push(reason);
    }
  };

  if (facts.tier.tier === "high") cap("human", "high-risk change");
  if (facts.tier.tier === "standard") cap("agent", "standard-risk change");
  if (review.findings.some((f) => f.severity === "blocker")) cap("human", "blocking finding");
  if (review.findings.some((f) => f.severity === "major")) cap("agent", "major finding");
  if (facts.baseline.failingOnHead.length > 0) cap("human", "tests fail on the PR");
  const statuses = [
    ...Object.values(review.dimensions).map((d) => d.status),
    coverageStatus(facts.coverage),
  ];
  if (statuses.includes("fail")) cap("human", "a check failed");
  if (statuses.includes("concern")) cap("agent", "a check has concerns");
  return { verdict, why };
}

const STATUS_ICON: Record<Status, string> = { pass: "✅", concern: "⚠️", fail: "❌", "n/a": "➖" };
const VERDICT_TITLE: Record<Verdict, string> = {
  auto: "✅ Can auto-merge",
  agent: "🤖 Needs an agent or human review",
  human: "👀 Needs a human review",
};
const SEVERITY_ICON = { blocker: "🛑", major: "🟠", minor: "🔹" };

const DIMENSION_LABELS: [keyof Review["dimensions"], string][] = [
  ["goal", "Achieves the goal"],
  ["tests", "Tests give signal"],
  ["reliability", "Reliability"],
  ["security", "Security"],
  ["complexity", "Complexity is needed"],
  ["maintainability", "Maintainability"],
  ["ui", "UI"],
];

function percent(ratio: number): string {
  return `${Math.round(ratio * 100)}%`;
}

function files(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function coverageNote(coverage: Facts["coverage"]): string {
  const parts: string[] = [];
  if (coverage.ratio !== null) {
    parts.push(`${percent(coverage.ratio)} of ${coverage.changedLines} changed lines`);
  }
  if (coverage.notLoaded.length > 0)
    parts.push(`${files(coverage.notLoaded.length)} no test loads`);
  if (coverage.unmeasured.length > 0)
    parts.push(`${files(coverage.unmeasured.length)} not measured`);
  return parts.join(", ") || "no executable lines changed";
}

function baselineNote(baseline: Facts["baseline"]): string {
  const total = baseline.detecting + baseline.notDetecting.length;
  if (total === 0 && baseline.failingOnHead.length === 0) return "";
  const parts = [`${baseline.detecting} of ${total} new or changed tests fail without the change`];
  if (baseline.failingOnHead.length > 0)
    parts.push(`${baseline.failingOnHead.length} fail on the PR`);
  return parts.join(", ");
}

function list(items: string[], limit = 15): string {
  const shown = items.slice(0, limit).map((item) => `- \`${item}\``);
  if (items.length > limit) shown.push(`- …and ${items.length - limit} more`);
  return shown.join("\n");
}

export function renderReport(review: Review, facts: Facts): { body: string; data: ReportData } {
  const { verdict, why } = finalVerdict(review, facts);
  const covStatus = coverageStatus(facts.coverage);
  const headline = review.findings.filter((f) => f.severity !== "minor");
  const minor = review.findings.filter((f) => f.severity === "minor");

  const rows = DIMENSION_LABELS.map(([key, label]) => {
    const dim = review.dimensions[key];
    const extra = key === "tests" ? baselineNote(facts.baseline) : "";
    const note = [dim.note, extra].filter(Boolean).join(". ");
    return `| ${STATUS_ICON[dim.status]} | ${label} | ${note} |`;
  });
  rows.splice(
    2,
    0,
    `| ${STATUS_ICON[covStatus]} | Diff coverage | ${coverageNote(facts.coverage)} |`,
  );

  const verdictLine =
    why.length > 0 && verdict !== review.verdict
      ? `${review.verdictReason} Capped by: ${why.join(", ")}.`
      : review.verdictReason;

  const lines = [
    REPORT_MARKER,
    `## ${VERDICT_TITLE[verdict]}`,
    "",
    `**Risk:** ${facts.tier.tier}${facts.tier.reasons.length ? ` (${facts.tier.reasons.join("; ")})` : ""} · **Head:** \`${facts.head.slice(0, 7)}\``,
    "",
    `**Goal:** ${review.goal}`,
    "",
    review.summary,
    "",
    `**Verdict:** ${verdictLine}`,
    "",
    "| | Check | Note |",
    "|---|---|---|",
    ...rows,
  ];

  if (headline.length > 0) {
    lines.push("", "### Findings", "");
    for (const f of headline) {
      const where = f.location ? ` \`${f.location}\`` : "";
      lines.push(`- ${SEVERITY_ICON[f.severity]} **${f.title}**${where}: ${f.detail}`);
    }
  }

  if (review.screenshots.length > 0) {
    lines.push("", "### Screenshots", "");
    for (const shot of review.screenshots) lines.push(`![${shot.caption}](${shot.path})`, "");
  }

  const details: string[] = [];
  if (minor.length > 0) {
    details.push(
      "**Minor findings**",
      "",
      ...minor.map((f) => `- ${f.title}${f.location ? ` \`${f.location}\`` : ""}: ${f.detail}`),
      "",
    );
  }
  if (facts.coverage.uncovered.length > 0) {
    details.push(
      "**Changed lines no test runs**",
      "",
      list(facts.coverage.uncovered.map((u) => `${u.path}:${u.lines}`)),
      "",
    );
  }
  if (facts.coverage.notLoaded.length > 0) {
    details.push("**Changed files no test loads**", "", list(facts.coverage.notLoaded), "");
  }
  if (facts.baseline.notDetecting.length > 0) {
    details.push(
      "**Tests that pass without the change**",
      "",
      list(facts.baseline.notDetecting),
      "",
    );
  }
  if (facts.baseline.failingOnHead.length > 0) {
    details.push("**Tests failing on the PR**", "", list(facts.baseline.failingOnHead), "");
  }
  if (details.length > 0) {
    lines.push("", "<details><summary>Details</summary>", "", ...details, "</details>");
  }

  const data: ReportData = {
    version: 1,
    headSha: facts.head,
    verdict,
    tier: facts.tier.tier,
    blockers: review.findings.filter((f) => f.severity === "blocker").length,
    majors: review.findings.filter((f) => f.severity === "major").length,
    failing: [
      ...DIMENSION_LABELS.filter(([key]) =>
        ["fail", "concern"].includes(review.dimensions[key].status),
      ).map(([key]) => key),
      ...(["fail", "concern"].includes(covStatus) ? ["coverage"] : []),
    ],
    coverage: facts.coverage.ratio,
  };

  lines.push(
    "",
    `<sub>${review.model} · ${review.reviewers.join(", ")} · suites: ${facts.suites.join(", ") || "none"}</sub>`,
    // Base64 so nothing in the data can close the HTML comment early.
    `<!-- yarvis-verify-data ${Buffer.from(JSON.stringify(data)).toString("base64")} -->`,
  );
  return { body: lines.join("\n"), data };
}

/** Reads the data block back out of a report comment, or `null` if it has none. */
export function parseReportData(body: string): ReportData | null {
  const match = body.match(DATA_PATTERN);
  if (!match) return null;
  try {
    const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    return data?.version === 1 ? (data as ReportData) : null;
  } catch {
    return null;
  }
}

interface Comment {
  id: number;
  body: string;
  user: { login: string };
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      pr: { type: "string" },
      review: { type: "string" },
      facts: { type: "string" },
      "dry-run": { type: "boolean", default: false },
    },
  });
  if (!values.pr || !values.review || !values.facts) {
    throw new Error("--pr, --review and --facts are required");
  }
  const review = Review.parse(JSON.parse(readFileSync(values.review, "utf8")));
  const facts = JSON.parse(readFileSync(values.facts, "utf8")) as Facts;
  const { body, data } = renderReport(review, facts);

  const bodyFile = join(dirname(values.facts), "report.md");
  writeFileSync(bodyFile, body);
  if (values["dry-run"]) {
    console.log(body);
    process.exit(0);
  }

  const pr = ghApi<{ head: { sha: string } }>(`repos/{owner}/{repo}/pulls/${values.pr}`);
  if (pr.head.sha !== facts.head) {
    throw new Error(
      `the PR head is ${pr.head.sha.slice(0, 7)} but the facts describe ${facts.head.slice(0, 7)}; re-run collect`,
    );
  }

  const me = ghApi<{ login: string }>("user").login;
  const previous = ghApiPages<Comment>(`repos/{owner}/{repo}/issues/${values.pr}/comments`).filter(
    (c) => c.user.login === me && c.body.includes(REPORT_MARKER),
  );

  // `gh pr comment --attach` uploads each screenshot and rewrites the matching
  // `![caption](path)` in the body to point at the upload.
  const attach = review.screenshots.flatMap((shot) => ["--attach", `${shot.path}#${shot.caption}`]);
  run("gh", ["pr", "comment", values.pr, "--body-file", bodyFile, ...attach]);
  // Posted first, deleted after, so the PR is never left without a report.
  for (const old of previous) {
    ghApi(`repos/{owner}/{repo}/issues/comments/${old.id}`, ["-X", "DELETE"]);
  }
  console.log(`Posted: ${data.verdict} (${data.tier} risk)`);
}
