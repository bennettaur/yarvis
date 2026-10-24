#!/usr/bin/env bun
/**
 * Renders a verification report and posts it on the pull request, replacing
 * the previous one. The review half comes from the `/verify-pr` skill as JSON;
 * the measured half comes from `collect.ts`. The length limits in the schema
 * are what keep the report shorter to read than the PR.
 *
 *   bun run verify:report --pr 123 --review review.json --facts facts.json [--dry-run]
 */

import { readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative } from "node:path";
import { parseArgs } from "node:util";
import { z } from "zod";
import type { Facts } from "./collect.ts";
import { ghApi, ghApiPages, run } from "./exec.ts";
import { REPORT_NAMESPACE, signPayload } from "./signing.ts";
import { stricterTier, type Tier } from "./tier.ts";

/** Marks a comment as a verification report. The gate looks for it. */
export const REPORT_MARKER = "<!-- yarvis-verify -->";
/**
 * The data block and its signature, which always end a posted report.
 * Anchored to the end so a block smuggled into the text above is never read.
 */
const SIGNED_DATA_PATTERN =
  /<!-- yarvis-verify-data ([A-Za-z0-9+/=]+) -->\s*<!-- yarvis-verify-sig ([A-Za-z0-9+/=]+) -->\s*$/;

/** Changed-line coverage at or above this passes; below the floor fails. */
const COVERAGE_PASS = 0.8;
const COVERAGE_FLOOR = 0.5;

/**
 * Below this share of mutants caught, the tests run the changed lines without
 * really checking them. Lower than the coverage bar because some mutants
 * (a log message's wording) aren't worth a test.
 */
const MUTATION_FLOOR = 0.6;

/** Fewer mutants than this are too few to judge the tests by. */
const MUTATION_MIN_MUTANTS = 10;

function hasWeakMutationScore(facts: Facts): boolean {
  const mutation = facts.mutation;
  if (!mutation || mutation.score === null) return false;
  const total = mutation.killed + mutation.survived.length;
  return total >= MUTATION_MIN_MUTANTS && mutation.score < MUTATION_FLOOR;
}

const Status = z.enum(["pass", "concern", "fail", "n/a"]);
type Status = z.infer<typeof Status>;

const Verdict = z.enum(["auto", "agent", "human"]);
type Verdict = z.infer<typeof Verdict>;
const VERDICT_STRICTNESS: Verdict[] = ["auto", "agent", "human"];

const Dimension = z.object({ status: Status, note: z.string().max(140) });

export const Review = z.object({
  /** What the PR is meant to achieve, in one line, taken from its description or issue. */
  goal: z.string().min(1).max(200),
  summary: z.string().min(1).max(300),
  verdict: Verdict,
  verdictReason: z.string().max(200),
  /**
   * How much harm the change could do, judged from what it does rather than
   * where it is: see the skill's risk assessment step. It can only raise the
   * tier the changed paths set, never lower it.
   */
  risk: z.object({
    tier: z.enum(["low", "standard", "high"]),
    reasons: z.array(z.string().max(140)).min(1).max(4),
  }),
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
  // Every screenshot is uploaded to a public PR, so the path is held to an
  // image file; `post` also checks it sits in the output directory.
  screenshots: z
    .array(
      z.object({
        path: z
          .string()
          .refine((path) => isAbsolute(path) && /^[^\s#()]+\.(png|jpe?g|gif|webp)$/i.test(path), {
            message: "must be an absolute path to an image, with no spaces, # or parentheses",
          }),
        caption: z.string().max(120),
      }),
    )
    .max(10)
    .default([]),
  /** The review agents that ran, and the model behind them, so reports stay comparable. */
  reviewers: z.array(z.string()).max(12),
  model: z.string().max(60),
});
export type Review = z.infer<typeof Review>;

/**
 * What the gate reads back out of a posted report. The repo, PR and commit
 * are inside what's signed, so a signed report can't be moved to another PR
 * or kept past a push.
 */
const ReportData = z.object({
  version: z.literal(2),
  repo: z.string(),
  pr: z.number().int().positive(),
  headSha: z.string(),
  verdict: Verdict,
  /** The stricter of the changed paths' tier and the assessed one. */
  riskTier: z.enum(["low", "standard", "high"]),
  blockers: z.number().int().nonnegative(),
  majors: z.number().int().nonnegative(),
  /** Dimensions, including coverage, whose status is `fail` or `concern`. */
  flagged: z.array(z.string()),
  /** The model that reviewed, so calibration can compare verdicts across models. */
  model: z.string().optional(),
});
export type ReportData = z.infer<typeof ReportData>;

const isFlagged = (status: Status) => status === "fail" || status === "concern";

export function coverageStatus(coverage: Facts["coverage"]): Status {
  if (coverage.notLoaded.length > 0) return coverage.ratio === null ? "fail" : "concern";
  if (coverage.ratio === null) return "n/a";
  if (coverage.ratio >= COVERAGE_PASS) return "pass";
  return coverage.ratio >= COVERAGE_FLOOR ? "concern" : "fail";
}

/**
 * Makes model- or PR-written text safe to put in one line of the report. `<`
 * and `>` become entities, so no HTML comment can open and hide a second data
 * block. Pipes would break the table, and @-mentions would ping people.
 *
 * Order matters: backslashes are escaped before pipes, so a `\` in the text
 * can't cancel the pipe's escape, and `&` before `<`, so text that is already
 * `&lt;` can't decode into a real `<`.
 */
export function inline(text: string): string {
  return text
    .replace(/\r?\n/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\|/g, "\\|")
    .replace(/@(?=\w)/g, "@\u200b");
}

/**
 * Text in a code span, for list items. HTML isn't parsed there, so only
 * backticks and newlines need handling. Not for table cells, where a pipe
 * would still end the cell.
 */
function code(text: string): string {
  return `\`${text.replace(/\r?\n/g, " ").replace(/`/g, "'")}\``;
}

/** The report's tier: the stricter of the changed paths' floor and the assessed risk. */
export function riskTier(review: Review, facts: Facts): Tier {
  return stricterTier(facts.tier.tier, review.risk.tier);
}

/**
 * The verdict a report may give, which is never looser than the risk tier
 * allows. Only a low-risk PR with nothing wrong is eligible to merge on its own.
 */
export function finalVerdict(review: Review, facts: Facts): { verdict: Verdict; why: string[] } {
  const why: string[] = [];
  let verdict = review.verdict;
  const requireAtLeast = (to: Verdict, reason: string) => {
    if (VERDICT_STRICTNESS.indexOf(to) > VERDICT_STRICTNESS.indexOf(verdict)) {
      verdict = to;
      why.push(reason);
    }
  };

  const tier = riskTier(review, facts);
  if (tier === "high") requireAtLeast("human", "high-risk change");
  if (tier === "standard") requireAtLeast("agent", "standard-risk change");
  if (review.findings.some((f) => f.severity === "blocker")) {
    requireAtLeast("human", "blocking finding");
  }
  if (review.findings.some((f) => f.severity === "major")) requireAtLeast("agent", "major finding");
  if (facts.baseline.failingOnHead.length > 0) requireAtLeast("human", "tests fail on the PR");
  if (hasWeakMutationScore(facts)) {
    requireAtLeast("agent", "tests miss many mutations on changed lines");
  }
  const statuses = [
    ...Object.values(review.dimensions).map((d) => d.status),
    coverageStatus(facts.coverage),
  ];
  if (statuses.includes("fail")) requireAtLeast("human", "a check failed");
  if (statuses.includes("concern")) requireAtLeast("agent", "a check has concerns");
  return { verdict, why };
}

const STATUS_ICON: Record<Status, string> = { pass: "✅", concern: "⚠️", fail: "❌", "n/a": "➖" };
const VERDICT_TITLE: Record<Verdict, string> = {
  auto: "✅ Can auto-merge",
  agent: "🤖 Needs an agent or human review",
  human: "👀 Needs a human review",
};
const SEVERITY_ICON: Record<Review["findings"][number]["severity"], string> = {
  blocker: "🛑",
  major: "🟠",
  minor: "🔹",
};

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

function fileCount(count: number): string {
  return count === 1 ? "1 file" : `${count} files`;
}

function coverageNote(coverage: Facts["coverage"]): string {
  const parts: string[] = [];
  if (coverage.ratio !== null) {
    parts.push(`${percent(coverage.ratio)} of ${coverage.changedLines} changed lines`);
  }
  if (coverage.notLoaded.length > 0)
    parts.push(`${fileCount(coverage.notLoaded.length)} no test loads`);
  if (coverage.unmeasured.length > 0)
    parts.push(`${fileCount(coverage.unmeasured.length)} not measured`);
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

function mutationNote(mutation: Facts["mutation"]): string {
  if (!mutation || mutation.score === null) return "";
  const total = mutation.killed + mutation.survived.length;
  const skipped =
    mutation.skippedRanges > 0 ? ` (${mutation.skippedRanges} ranges not mutated)` : "";
  return `${percent(mutation.score)} of ${total} mutants on changed lines caught${skipped}`;
}

function bulletList(items: string[], limit = 15): string {
  const shown = items.slice(0, limit).map((item) => `- ${code(item)}`);
  if (items.length > limit) shown.push(`- …and ${items.length - limit} more`);
  return shown.join("\n");
}

/** Where a report will be posted, which its signed data names. */
export interface ReportTarget {
  /** `owner/name`. */
  repo: string;
  pr: number;
}

/**
 * The report's markdown, ending in its data block, and that block's base64
 * text: the exact string `signReport` signs.
 */
export function renderReport(
  review: Review,
  facts: Facts,
  target: ReportTarget,
): { body: string; data: ReportData; payload: string } {
  const { verdict, why } = finalVerdict(review, facts);
  const coverage = coverageStatus(facts.coverage);
  const headlineFindings = review.findings.filter((f) => f.severity !== "minor");
  const minorFindings = review.findings.filter((f) => f.severity === "minor");
  const where = (location?: string) => (location ? ` ${code(location)}` : "");

  // Coverage sits right after the tests row, since the two are read together.
  const rows = DIMENSION_LABELS.flatMap(([key, label]) => {
    const dim = review.dimensions[key];
    const extra =
      key === "tests"
        ? [baselineNote(facts.baseline), mutationNote(facts.mutation)].filter(Boolean).join(". ")
        : "";
    const note = inline([dim.note, extra].filter(Boolean).join(". "));
    const row = `| ${STATUS_ICON[dim.status]} | ${label} | ${note} |`;
    if (key !== "tests") return [row];
    return [row, `| ${STATUS_ICON[coverage]} | Diff coverage | ${coverageNote(facts.coverage)} |`];
  });

  const verdictLine =
    verdict !== review.verdict
      ? `${inline(review.verdictReason)} Raised by: ${why.join(", ")}.`
      : inline(review.verdictReason);
  const tier = riskTier(review, facts);
  // Each source labeled, since they can disagree: "assessed low" next to
  // "floor high" says the paths won, where an unlabeled list reads as a muddle.
  const floorReasons = facts.tier.reasons.length ? `: ${facts.tier.reasons.join("; ")}` : "";
  const riskReasons = `assessed ${review.risk.tier}: ${review.risk.reasons.join("; ")}; floor ${facts.tier.tier}${floorReasons}`;

  const lines = [
    REPORT_MARKER,
    `## ${VERDICT_TITLE[verdict]}`,
    "",
    `**Risk:** ${tier} (${inline(riskReasons)}) · **Head:** \`${facts.head.slice(0, 7)}\``,
    "",
    `**Goal:** ${inline(review.goal)}`,
    "",
    inline(review.summary),
    "",
    `**Verdict:** ${verdictLine}`,
    "",
    "| | Check | Note |",
    "|---|---|---|",
    ...rows,
  ];

  if (headlineFindings.length > 0) {
    lines.push("", "### Findings", "");
    for (const f of headlineFindings) {
      lines.push(
        `- ${SEVERITY_ICON[f.severity]} **${inline(f.title)}**${where(f.location)}: ${inline(f.detail)}`,
      );
    }
  }

  if (review.screenshots.length > 0) {
    lines.push("", "### Screenshots", "");
    for (const shot of review.screenshots) {
      lines.push(`![${inline(shot.caption).replace(/[[\]]/g, "")}](${shot.path})`, "");
    }
  }

  const details: string[] = [];
  if (minorFindings.length > 0) {
    details.push(
      "**Minor findings**",
      "",
      ...minorFindings.map((f) => `- ${inline(f.title)}${where(f.location)}: ${inline(f.detail)}`),
      "",
    );
  }
  if (facts.coverage.uncovered.length > 0) {
    details.push(
      "**Changed lines no test runs**",
      "",
      bulletList(facts.coverage.uncovered.map((u) => `${u.path}:${u.lines}`)),
      "",
    );
  }
  if (facts.coverage.notLoaded.length > 0) {
    details.push("**Changed files no test loads**", "", bulletList(facts.coverage.notLoaded), "");
  }
  if (facts.baseline.notDetecting.length > 0) {
    details.push(
      "**Tests that pass without the change**",
      "",
      bulletList(facts.baseline.notDetecting),
      "",
    );
  }
  if (facts.baseline.failingOnHead.length > 0) {
    details.push("**Tests failing on the PR**", "", bulletList(facts.baseline.failingOnHead), "");
  }
  if (facts.mutation && facts.mutation.survived.length > 0) {
    details.push(
      "**Mutations no test caught**",
      "",
      bulletList(
        [...facts.mutation.survived].sort((a, b) => a.localeCompare(b, "en", { numeric: true })),
      ),
      "",
    );
  }
  if (details.length > 0) {
    lines.push("", "<details><summary>Details</summary>", "", ...details, "</details>");
  }

  const data: ReportData = {
    version: 2,
    repo: target.repo,
    pr: target.pr,
    headSha: facts.head,
    verdict,
    riskTier: tier,
    blockers: review.findings.filter((f) => f.severity === "blocker").length,
    majors: review.findings.filter((f) => f.severity === "major").length,
    flagged: [
      ...DIMENSION_LABELS.filter(([key]) => isFlagged(review.dimensions[key].status)).map(
        ([key]) => key,
      ),
      ...(isFlagged(coverage) ? ["coverage"] : []),
      ...(hasWeakMutationScore(facts) ? ["mutation"] : []),
    ],
    model: review.model,
  };

  // Base64 so nothing in the data can close the HTML comment early.
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const suites = facts.suites.join(", ") || "none";
  lines.push(
    "",
    `<sub>${inline(review.model)} · ${inline(review.reviewers.join(", "))} · suites: ${suites}</sub>`,
    `<!-- yarvis-verify-data ${payload} -->`,
  );
  return { body: lines.join("\n"), data, payload };
}

/** Appends the signature block that the gate requires after the data block. */
export function withSignature(body: string, signature: string): string {
  return `${body}\n<!-- yarvis-verify-sig ${signature} -->`;
}

export interface SignedReport {
  data: ReportData;
  /** The data block's base64 text, which is what was signed. */
  payload: string;
  /** The armored SSH signature, base64-encoded. */
  signature: string;
}

/**
 * Reads the data block and its signature from a report comment, or `null` if
 * either is missing or the data is malformed. It doesn't check the signature;
 * `signing.ts`'s `verifiedSigner` does.
 */
export function parseSignedReport(body: string): SignedReport | null {
  const match = body.match(SIGNED_DATA_PATTERN);
  if (!match) return null;
  try {
    const parsed = ReportData.safeParse(
      JSON.parse(Buffer.from(match[1], "base64").toString("utf8")),
    );
    return parsed.success ? { data: parsed.data, payload: match[1], signature: match[2] } : null;
  } catch {
    return null;
  }
}

interface Comment {
  id: number;
  body: string;
  user: { id: number };
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
  if (!/^[1-9]\d*$/.test(values.pr)) throw new Error("--pr must be a PR number");
  const review = Review.parse(JSON.parse(readFileSync(values.review, "utf8")));
  const facts = JSON.parse(readFileSync(values.facts, "utf8")) as Facts;
  const repo = run("gh", [
    "repo",
    "view",
    "--json",
    "nameWithOwner",
    "--jq",
    ".nameWithOwner",
  ]).stdout.trim();
  const { body, data, payload } = renderReport(review, facts, { repo, pr: Number(values.pr) });

  const outDir = realpathSync(dirname(values.facts));
  for (const shot of review.screenshots) {
    const inside = relative(outDir, realpathSync(shot.path));
    if (inside.startsWith("..") || isAbsolute(inside)) {
      throw new Error(`screenshot ${shot.path} is outside ${outDir}; copy it there first`);
    }
  }
  const bodyFile = join(outDir, "report.md");
  if (values["dry-run"]) {
    writeFileSync(bodyFile, body);
    console.log(body);
    process.exit(0);
  }

  const pr = ghApi<{ head: { sha: string } }>(`repos/{owner}/{repo}/pulls/${values.pr}`);
  if (pr.head.sha !== facts.head) {
    throw new Error(
      `the PR head is ${pr.head.sha.slice(0, 7)} but the facts describe ${facts.head.slice(0, 7)}; re-run collect`,
    );
  }

  // Signed last, after every check that could refuse the post, so a
  // 1Password prompt only appears for a report that will be posted.
  writeFileSync(bodyFile, withSignature(body, signPayload(payload, REPORT_NAMESPACE)));

  const me = ghApi<{ id: number }>("user").id;
  const previous = ghApiPages<Comment>(
    `repos/{owner}/{repo}/issues/${values.pr}/comments?per_page=100`,
  ).filter((c) => c.user.id === me && c.body.includes(REPORT_MARKER));

  // `gh pr comment --attach` uploads each screenshot and rewrites the matching
  // `![caption](path)` in the body to point at the upload.
  const attach = review.screenshots.flatMap((shot) => ["--attach", `${shot.path}#${shot.caption}`]);
  run("gh", ["pr", "comment", values.pr, "--body-file", bodyFile, ...attach]);
  // Posted first, deleted after, so the PR is never left without a report.
  for (const old of previous) {
    ghApi(`repos/{owner}/{repo}/issues/comments/${old.id}`, ["-X", "DELETE"]);
  }
  console.log(`Posted: ${data.verdict} (${data.riskTier} risk)`);
}
