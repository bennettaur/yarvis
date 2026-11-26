import type { ReviewPrepVerdict } from "../db/schema.ts";
import type { ChecklistItem, ChecklistReport } from "../reviewWorkspaces/checklist.ts";
import {
  CHECK_SECTIONS,
  DEFAULT_SECTIONS,
  type ReportSection,
  type VerificationSize,
} from "../reviewWorkspaces/verification.ts";

/**
 * What a prepared PR's attention item says: a verdict from the checks, the
 * files to read first and how long the review should take.
 *
 * The verdict is a short form of the Decision panel's suggestion, read from
 * the checks alone. CI and bot comments are left out, since they are read from
 * the provider when the panel opens, so the item never says "approve".
 */

export const VERDICT_TEXT: Record<ReviewPrepVerdict, string> = {
  "changes-needed": "Changes likely needed",
  "review-deeper": "Review deeper first",
  "no-problems": "The checks found no problems",
};

export interface PrepSummary {
  verdict: ReviewPrepVerdict;
  /** Why, in Yarvis's words; empty for no-problems. */
  reasons: string[];
  mustRead: string[];
  /** Null when the PR couldn't be sized. */
  reviewMinutes: number | null;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * The same blockers and concerns the Decision panel counts, minus CI and the
 * bots: a high finding or a missing claim means changes; high risk, an
 * outlier, a partial claim, a medium finding, a simpler approach or a check
 * not run on this commit means a closer look.
 */
export function summarizePrep(
  report: ChecklistReport | null,
  items: readonly ChecklistItem[],
  size: VerificationSize | null,
  /** The sections the prep asked for; one it didn't ask for isn't missing. */
  asked: readonly ReportSection[] = DEFAULT_SECTIONS,
): PrepSummary {
  const blockers: string[] = [];
  const concerns: string[] = [];
  const findings = [
    ...CHECK_SECTIONS.flatMap((key) => report?.[key]?.findings ?? []),
    ...(report?.claims?.gaps ?? []),
  ];
  const high = findings.filter((f) => f.severity === "high").length;
  const medium = findings.filter((f) => f.severity === "medium").length;
  if (high > 0) blockers.push(plural(high, "high finding", "high findings"));
  const unmet = (report?.claims?.items ?? []).filter(
    (c) => c.status === "missing" || c.status === "contradicted",
  ).length;
  if (unmet > 0) blockers.push(plural(unmet, "claim not met", "claims not met"));

  if (report?.risk?.level === "high") concerns.push("high risk");
  const outliers = (report?.changeMap?.themes ?? []).filter((t) => t.cohesion === "outlier").length;
  if (outliers > 0) concerns.push(plural(outliers, "outlier", "outliers"));
  const partial = (report?.claims?.items ?? []).filter((c) => c.status === "partial").length;
  if (partial > 0) concerns.push(plural(partial, "claim partly met", "claims partly met"));
  if (medium > 0) concerns.push(plural(medium, "medium finding", "medium findings"));
  const rating = report?.approach?.rating;
  if (rating === "simpler" || rating === "much-simpler") concerns.push("a simpler approach");
  const notRun = items.filter((i) => asked.includes(i.section) && !i.result?.current);
  if (notRun.length > 0) {
    concerns.push(plural(notRun.length, "check without a result", "checks without a result"));
  }

  let verdict: ReviewPrepVerdict = "no-problems";
  if (blockers.length > 0) verdict = "changes-needed";
  else if (concerns.length > 0) verdict = "review-deeper";
  return {
    verdict,
    reasons: [...blockers, ...concerns],
    mustRead: (report?.mustRead ?? []).map((m) => m.path),
    reviewMinutes: size ? estimateReviewMinutes(size) : null,
  };
}

/**
 * About 300 changed lines an hour, plus a minute per file to find your way
 * around it, rounded up to 5 minutes. Skimmed files (lockfiles, generated
 * code) and binaries add only the per-file time.
 */
export function estimateReviewMinutes(
  size: Pick<VerificationSize, "files" | "changedLines">,
): number {
  const minutes = size.changedLines / 5 + size.files;
  return Math.max(5, Math.ceil(minutes / 5) * 5);
}

/** "45 min", "1 h 30 min". */
export function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours} h` : `${hours} h ${rest} min`;
}

/** Most must-read paths the item lists; the report has the rest. */
const MAX_MUST_READ_LISTED = 5;

/**
 * The item's body. `name` is `repo#12`; `title` is the PR's, written by its
 * author, which is why the whole thing goes in the body and never the title.
 */
export function prepBody(name: string, title: string | null, summary: PrepSummary): string {
  const lines = [title ? `${name}: ${title}` : name];
  const reasons = summary.reasons.length ? ` (${summary.reasons.join(", ")})` : "";
  lines.push(`Verdict: ${VERDICT_TEXT[summary.verdict]}${reasons}.`);
  if (summary.mustRead.length > 0) {
    const listed = summary.mustRead.slice(0, MAX_MUST_READ_LISTED);
    const more = summary.mustRead.length - listed.length;
    lines.push(`Must read: ${listed.join(", ")}${more > 0 ? `, and ${more} more` : ""}.`);
  }
  if (summary.reviewMinutes !== null) {
    lines.push(`Estimated review time: about ${formatMinutes(summary.reviewMinutes)}.`);
  }
  return lines.join("\n");
}
