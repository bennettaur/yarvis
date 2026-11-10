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
import {
  ATTENTION_BAND,
  BAND_LABELS,
  CHANGE_KINDS,
  changeBand,
  describeCounts,
  EVIDENCE,
  type Evidence,
  type Impact,
  REACHES,
  type Reach,
  scoreImpact,
} from "../../sidecar/src/verify/impact.ts";
import type { Facts } from "./collect.ts";
import { isMeasurableSource } from "./diffCoverage.ts";
import { ghApi, ghApiPages, run } from "./exec.ts";
import { REPORT_NAMESPACE, signPayload } from "./signing.ts";
import { floorTier, isDependencyFile, stricterTier, type Tier } from "./tier.ts";

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

/**
 * `visual` is a PR that is otherwise clean but changes what the app shows:
 * the maintainer looks at its screenshots and merges it with `/approve`.
 */
const Verdict = z.enum(["auto", "visual", "agent", "human"]);
type Verdict = z.infer<typeof Verdict>;
const VERDICT_STRICTNESS: Verdict[] = ["auto", "visual", "agent", "human"];

const Dimension = z.object({ status: Status, note: z.string().max(140) });

/**
 * One independent change in the PR, classified for `impact.ts` to score. An
 * interface change and the callers it updates are one change; so is a rename
 * across many files.
 */
const Change = z
  .object({
    title: z.string().min(1).max(100),
    /** `path:line` or `path:start-end` of the changed thing, or just the path. */
    location: z.string().min(1).max(120),
    kind: z.enum(CHANGE_KINDS),
    reach: z.enum(REACHES),
    evidence: z.enum(EVIDENCE),
    sensitive: z.boolean().default(false),
    /** How many alike changes this entry stands for. */
    count: z.number().int().min(1).max(1000).default(1),
    /** What a reviewer should check. Required on a change scored high enough to list. */
    check: z.string().max(200).default(""),
  })
  .refine((change) => change.check !== "" || changeBand(change) < ATTENTION_BAND, {
    message: "a change scored high or very high must say what to check",
    path: ["check"],
  });

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
  /** Every independent change, for the impact score. */
  changes: z.array(Change).min(1),
  /**
   * The skill's rating of each file the path floor sent for assessment
   * (`facts.tier.assess`). One left out counts as high.
   */
  assessed: z
    .array(
      z.object({
        path: z.string().max(200),
        tier: z.enum(["standard", "high"]),
        reason: z.string().max(140),
      }),
    )
    .max(50)
    .default([]),
  dimensions: z.object({
    goal: Dimension,
    tests: Dimension,
    reliability: Dimension,
    security: Dimension,
    complexity: Dimension,
    maintainability: Dimension,
    ui: Dimension,
    /** The skill's analysis of added and bumped packages; `n/a` when no dependency changed. */
    supplyChain: Dimension,
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
  /** When it was signed, ISO 8601, so a re-posted old report can be refused. */
  issuedAt: z.string().datetime(),
  verdict: Verdict,
  /** The stricter of the changed paths' tier and the assessed one. */
  riskTier: z.enum(["low", "standard", "high"]),
  /**
   * The files the skill assessed out of those the path floor flagged. The
   * gate counts any flagged file missing here as high.
   */
  assessed: z.array(z.string()).optional(),
  blockers: z.number().int().nonnegative(),
  majors: z.number().int().nonnegative(),
  /** Dimensions, including coverage, whose status is `fail` or `concern`. */
  flagged: z.array(z.string()),
  /**
   * A person has to look at what the PR shows before it merges: the verdict
   * is `visual`, or the UI check was flagged. The merge reviewer can't
   * approve one, whatever the verdict.
   */
  needsVisual: z.boolean().optional(),
  /** The model that reviewed, so calibration can compare verdicts across models. */
  model: z.string().optional(),
  /** The impact score's band, 1 to 5, so calibration can check it against escapes. */
  impactBand: z.number().int().min(1).max(5).optional(),
});
export type ReportData = z.infer<typeof ReportData>;

const isFlagged = (status: Status) => status === "fail" || status === "concern";

export function coverageStatus(coverage: Facts["coverage"]): Status {
  // A suite that ran no tests leaves its files with no evidence at all.
  if (coverage.noTestsRan.length > 0) return "fail";
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

type ReviewChange = Review["changes"][number];

/** A change's path, from a `location` of `path`, `path:line` or `path:start-end`. */
function changePath(change: ReviewChange): string {
  return change.location.replace(/:\d+(-\d+)?$/, "");
}

/** The changed files a location names: the file itself, or every one under a folder ending in `/`. */
function filesAt(location: string, facts: Facts): Facts["files"] {
  return facts.files.filter(
    (file) => file.path === location || (location.endsWith("/") && file.path.startsWith(location)),
  );
}

/**
 * Whether coverage backs a `proven` claim: the location names changed source
 * files that gained lines, and tests ran every one of them. It fails closed:
 * a location naming no changed file, a file coverage can't measure (docs,
 * config, SQL, a file the diff only deletes from), a file no test loads, and
 * a PR measured with `--static` all count as unbacked.
 */
function coverageBacks(change: ReviewChange, facts: Facts): boolean {
  const files = filesAt(changePath(change), facts);
  const { uncovered, unmeasured, notLoaded, noTestsRan } = facts.coverage;
  const untested = new Set([
    ...uncovered.map((u) => u.path),
    ...unmeasured,
    ...notLoaded,
    ...noTestsRan,
  ]);
  return (
    files.length > 0 &&
    files.every(
      (file) => isMeasurableSource(file.path) && file.additions > 0 && !untested.has(file.path),
    )
  );
}

/** The higher of a change's claimed reach and what the import graph suggests for its files. */
function measuredReach(change: ReviewChange, facts: Facts): Reach {
  const paths = new Set(filesAt(changePath(change), facts).map((file) => file.path));
  return (facts.reach ?? [])
    .filter((file) => paths.has(file.path))
    .reduce<Reach>(
      (reach, file) =>
        REACHES.indexOf(file.suggested) > REACHES.indexOf(reach) ? file.suggested : reach,
      change.reach,
    );
}

/**
 * Changed code files no change in the review names, each as a partly tested
 * logic change at its measured reach, since a change the review left out is
 * one nobody judged. Only an interface or logic change names a whole folder:
 * otherwise one passive entry at `src/` would vouch for every file under it.
 * A file the graph has no reach for (Rust, TypeScript outside the source
 * roots) counts as shared, so an unjudged one still reaches the agent reviewer.
 */
function unlistedChanges(review: Review, facts: Facts): ReviewChange[] {
  const named = new Set(
    review.changes.flatMap((change) => {
      const path = changePath(change);
      const wholeFolders = change.kind === "interface" || change.kind === "logic";
      return wholeFolders ? filesAt(path, facts) : facts.files.filter((f) => f.path === path);
    }),
  );
  return facts.files
    .filter((file) => isMeasurableSource(file.path) && !named.has(file))
    .map((file) => ({
      title: "Change the review didn't list",
      location: file.path,
      kind: "logic",
      reach: facts.reach?.find((r) => r.path === file.path)?.suggested ?? "shared",
      evidence: "partial",
      sensitive: false,
      count: 1,
      check: "Nobody classified this file's change: read it.",
    }));
}

/**
 * The PR's impact, from the review's changes as the facts allow, so a
 * classification steered by the PR's own text can't score lower than the
 * facts say:
 * - a `proven` claim coverage doesn't back is scored as `partial`;
 * - any change that could alter behaviour (interface, logic, removal, or a
 *   reorganization coverage doesn't prove) is scored at no less than the
 *   reach its files' importers suggest;
 * - a changed code file no change names is scored as an unlisted logic change.
 * It can't catch a change called by a lower kind.
 */
function measuredImpact(review: Review, facts: Facts): Impact<ReviewChange> | null {
  const adjusted = review.changes.map((change) => {
    const evidence =
      change.evidence === "proven" && change.kind !== "passive" && !coverageBacks(change, facts)
        ? "partial"
        : change.evidence;
    // An unproven reorganization scores as logic, so it gets logic's floor too.
    const canAlterBehaviour =
      ["interface", "logic", "removal"].includes(change.kind) ||
      (change.kind === "reorganization" && evidence !== "proven");
    const reach = canAlterBehaviour ? measuredReach(change, facts) : change.reach;
    return { ...change, evidence, reach };
  });
  return scoreImpact([...adjusted, ...unlistedChanges(review, facts)]);
}

/** The report's tier: the stricter of the changed paths' floor and the assessed risk. */
export function riskTier(review: Review, facts: Facts): Tier {
  const floor = floorTier(
    facts.tier,
    review.assessed.map((file) => file.path),
  );
  const assessedHigh = review.assessed.some((file) => file.tier === "high");
  return stricterTier(stricterTier(floor, review.risk.tier), assessedHigh ? "high" : "low");
}

/**
 * The verdict a report may give, which is never looser than the risk tier
 * and the checks allow. A low- or standard-risk PR with no blocker, major or
 * flagged check can merge on its own; minor findings don't hold it back.
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

  if (riskTier(review, facts) === "high") requireAtLeast("human", "high-risk change");
  const impact = measuredImpact(review, facts);
  if (impact && impact.band >= 5) requireAtLeast("human", "very high impact");
  if (impact && impact.band >= ATTENTION_BAND) requireAtLeast("agent", "high-impact changes");
  if (review.findings.some((f) => f.severity === "blocker")) {
    requireAtLeast("human", "blocking finding");
  }
  if (review.findings.some((f) => f.severity === "major")) requireAtLeast("agent", "major finding");
  if (facts.baseline.failingOnHead.length > 0) requireAtLeast("human", "tests fail on the PR");
  if (hasWeakMutationScore(facts)) {
    requireAtLeast("agent", "tests miss many mutations on changed lines");
  }
  const { ui, supplyChain } = review.dimensions;
  // `n/a` is the skill's claim that no dependency changed; the paths check it.
  if (supplyChain.status === "n/a" && facts.files.some((file) => isDependencyFile(file.path))) {
    requireAtLeast("agent", "dependencies changed without a supply-chain check");
  }
  const statuses = [
    ...Object.values(review.dimensions).map((d) => d.status),
    coverageStatus(facts.coverage),
  ];
  if (statuses.includes("fail")) requireAtLeast("human", "a check failed");
  if (statuses.includes("concern")) requireAtLeast("agent", "a check has concerns");
  // A UI change is judged by looking at it, so one with no screenshots can't
  // merge on the report. Whether a person also looks is the review's call:
  // `visual` for a new screen or a design change, not for a small one the
  // screenshots already show working.
  if (ui.status === "pass" && review.screenshots.length === 0) {
    requireAtLeast("agent", "UI change without screenshots");
  }
  return { verdict, why };
}

const STATUS_ICON: Record<Status, string> = { pass: "✅", concern: "⚠️", fail: "❌", "n/a": "➖" };
const VERDICT_TITLE: Record<Verdict, string> = {
  auto: "✅ Can auto-merge",
  visual: "👁️ Good to merge after a visual check",
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
  ["supplyChain", "Supply chain"],
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
  if (coverage.noTestsRan.length > 0)
    parts.push(`${fileCount(coverage.noTestsRan.length)} in a suite that ran no tests`);
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

const EVIDENCE_TEXT: Record<Evidence, string> = {
  proven: "proven by tests",
  partial: "partly tested",
  unproven: "untested",
};

/** The change's reach, with its file's measured importers when `collect` counted them. */
function reachText(change: ReviewChange, facts: Facts): string {
  const path = changePath(change);
  const measured = facts.reach?.find((file) => file.path === path);
  if (!measured) return change.reach;
  const importers = measured.importers === 1 ? "1 importer" : `${measured.importers} importers`;
  const areas = measured.otherAreas === 1 ? "1 other area" : `${measured.otherAreas} other areas`;
  return `${change.reach}; its file has ${importers} in ${areas}`;
}

function describeChange(change: ReviewChange, facts: Facts): string {
  const times = change.count > 1 ? ` (${change.count} like it)` : "";
  const sensitive = change.sensitive ? ", sensitive" : "";
  return `${change.kind}, ${reachText(change, facts)}, ${EVIDENCE_TEXT[change.evidence]}${sensitive}${times}`;
}

function impactLine(impact: Impact<ReviewChange>): string {
  const parts = [`${BAND_LABELS[impact.band]} (${impact.band}/5)`, describeCounts(impact.counts)];
  if (impact.raisedByVolume > 0) {
    parts.push(
      `raised from ${BAND_LABELS[impact.highestChangeBand]} by the number of changes, so splitting the PR would lower it`,
    );
  }
  return parts.join(" · ");
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
 * text: the exact string `signing.ts`'s `signPayload` signs.
 */
export function renderReport(
  review: Review,
  facts: Facts,
  target: ReportTarget,
  now: Date = new Date(),
): { body: string; data: ReportData; payload: string } {
  const { verdict, why } = finalVerdict(review, facts);
  const impact = measuredImpact(review, facts);
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
    ...(impact ? [`**Impact:** ${inline(impactLine(impact))}`, ""] : []),
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

  if (facts.tier.assess.length > 0) {
    const rated = new Map(review.assessed.map((file) => [file.path, file]));
    lines.push("", "### Sensitive files", "");
    for (const { path, reason } of facts.tier.assess) {
      const file = rated.get(path);
      lines.push(
        file
          ? `- ${code(path)}: ${file.tier}. ${inline(file.reason)}`
          : `- ${code(path)}: not assessed, so high. Flagged for ${inline(reason)}.`,
      );
    }
  }

  if (impact && impact.attention.length > 0) {
    lines.push("", "### Needs attention", "");
    for (const change of impact.attention) {
      // The schema checks the claimed band; the coverage check can raise it past one without a check.
      lines.push(
        `- **${inline(change.title)}** ${code(change.location)}: ${inline(describeChange(change, facts))}. Check: ${inline(change.check || "none given, so read this change")}`,
      );
    }
  }

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
      "Small enough not to hold the merge back, but still worth fixing in this PR.",
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
  if (facts.coverage.noTestsRan.length > 0) {
    details.push(
      "**Changed files in a suite that ran no tests**",
      "",
      bulletList(facts.coverage.noTestsRan),
      "",
    );
  }
  if (facts.baseline.notDetecting.length > 0) {
    details.push(
      "**New or changed tests that pass without the change**",
      "",
      "This PR adds or edits these tests, but they also pass on the base branch, so they " +
        "wouldn't notice the change being reverted. For a feature or a fix, make each one " +
        "check the new behavior, or remove it if another test already does. For a pure " +
        "refactor, this is expected.",
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
      "**Changed lines the tests run but don't check**",
      "",
      "Each item is a small breaking edit to a changed line, such as a flipped comparison " +
        "or a dropped branch, and every test still passed with it. Add or tighten a test " +
        "so it fails on the edit. Skip edits that change nothing a user would notice, " +
        "like a log message's wording.",
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
    issuedAt: now.toISOString(),
    verdict,
    riskTier: tier,
    assessed: review.assessed.map((file) => file.path),
    blockers: review.findings.filter((f) => f.severity === "blocker").length,
    majors: review.findings.filter((f) => f.severity === "major").length,
    flagged: [
      ...DIMENSION_LABELS.filter(([key]) => isFlagged(review.dimensions[key].status)).map(
        ([key]) => key,
      ),
      ...(isFlagged(coverage) ? ["coverage"] : []),
      ...(hasWeakMutationScore(facts) ? ["mutation"] : []),
    ],
    needsVisual: verdict === "visual" || isFlagged(review.dimensions.ui.status),
    model: review.model,
    ...(impact && { impactBand: impact.band }),
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
