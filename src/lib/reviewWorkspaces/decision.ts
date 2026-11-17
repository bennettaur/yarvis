/**
 * What the verification checklist adds up to: a suggested decision on the PR
 * with the reasons for it, the comments a "request changes" review would
 * carry, and where to look when the answer is "review deeper".
 *
 * The rules are deliberately few and visible: the panel shows every reason, so
 * the reviewer can see why it suggests what it does and disagree.
 */

import type { MutationRun } from "./mutation";
import {
  CHECK_LABEL,
  type ChecklistItem,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  findingCommentBody,
  type Severity,
  VERIFICATION_CHECKS,
  type VerificationReport,
} from "./verification";

export type Suggestion = "approve" | "request_changes" | "review_deeper" | "run_checks";

export interface Assessment {
  suggestion: Suggestion;
  /** Why changes are needed: each one is enough on its own. */
  blockers: string[];
  /** What deserves a closer look before approving. */
  concerns: string[];
  /** Labels of the default checks with no result for the PR's head. */
  notRun: string[];
}

/** Impact bands run 1 to 5; 4 and 5 are the ones `verify/impact.ts` calls high. */
const HIGH_IMPACT_BAND = 4;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function countFindings(report: VerificationReport, severity: Severity): number {
  const inChecks = VERIFICATION_CHECKS.reduce(
    (n, key) => n + (report[key]?.findings.filter((f) => f.severity === severity).length ?? 0),
    0,
  );
  const inGaps = report.claims?.gaps.filter((g) => g.severity === severity).length ?? 0;
  return inChecks + inGaps;
}

/** What CI says about approving: a blocker when it fails, a concern until it passes. */
function ciReasons(
  evidence: readonly EvidenceItem[] | null,
  blockers: string[],
  concerns: string[],
) {
  const ci = evidence?.find((e) => e.id === "ci-checks");
  if (!ci) concerns.push("No CI results for this commit yet");
  else if (ci.tone === "bad") blockers.push(`CI: ${ci.summary}`);
  else if (ci.tone !== "good") concerns.push(`CI: ${ci.summary}`);
}

/**
 * The suggested decision. Changes are needed when CI fails, a scanner raised a
 * high alert, a claim isn't met, or a check found something high. A closer
 * look is due for a risky change, an outlier, a partial claim, a medium
 * finding, a simpler approach, a security bot's comment, CI that hasn't
 * passed, or a check not run on the PR's head. Approving is suggested only
 * when none of that is there.
 *
 * `evidence` is null when there is none for the PR's head: not loaded yet, or
 * read at another commit.
 */
export function assessReview(
  report: VerificationReport | null,
  evidence: readonly EvidenceItem[] | null,
  items: readonly ChecklistItem[],
  mutation: MutationRun | null = null,
): Assessment {
  const blockers: string[] = [];
  const concerns: string[] = [];
  const judged = items.filter((i) => DEFAULT_SECTIONS.includes(i.section));
  const notRun = judged.filter((i) => !i.result?.current).map((i) => i.label);

  ciReasons(evidence, blockers, concerns);
  const scanning = evidence?.find((e) => e.id === "code-scanning");
  const highAlerts = scanning?.entries.filter((e) => e.severity === "high").length ?? 0;
  if (highAlerts > 0) {
    blockers.push(plural(highAlerts, "high code scanning alert", "high code scanning alerts"));
  }
  const securityBots = evidence?.find((e) => e.id === "security-bots");
  if (securityBots && securityBots.entries.length > 0) {
    concerns.push(`Security bots commented: ${securityBots.summary}`);
  }

  if (report) {
    for (const c of report.claims?.items ?? []) {
      if (c.status === "missing" || c.status === "contradicted") {
        blockers.push(`Claim ${c.status}: ${c.claim}`);
      }
    }
    const partial = report.claims?.items.filter((c) => c.status === "partial").length ?? 0;
    if (partial > 0) {
      concerns.push(plural(partial, "claim only partly met", "claims only partly met"));
    }

    const high = countFindings(report, "high");
    if (high > 0) blockers.push(plural(high, "high finding", "high findings"));
    const medium = countFindings(report, "medium");
    if (medium > 0) concerns.push(plural(medium, "medium finding", "medium findings"));

    const { risk } = report;
    if (risk && (risk.level === "high" || (risk.impact?.band ?? 0) >= HIGH_IMPACT_BAND)) {
      concerns.push(`High risk: ${risk.clientImpact}`);
    }
    const outliers = report.changeMap?.themes.filter((t) => t.cohesion === "outlier") ?? [];
    if (outliers.length > 0) {
      concerns.push(
        `${plural(outliers.length, "change doesn't", "changes don't")} seem to belong to the PR's goal: ${outliers.map((t) => t.title).join(", ")}`,
      );
    }
    const rating = report.approach?.rating;
    if (rating === "simpler" || rating === "much-simpler") {
      concerns.push(
        rating === "much-simpler" ? "A much simpler way exists" : "A simpler way exists",
      );
    }
  }

  // Mutation testing runs the PR's code, so it is opt-in: not having run it isn't a gap.
  const summary = mutation?.isCurrentHead && mutation.status === "succeeded" && mutation.summary;
  if (summary && (summary.verdict === "weak" || summary.verdict === "mixed")) {
    concerns.push(
      `Mutation testing: ${summary.verdict}, ${plural(summary.survived, "mutant", "mutants")} the tests missed`,
    );
  }

  const nothingRun = judged.length > 0 && notRun.length === judged.length;
  let suggestion: Suggestion;
  if (blockers.length > 0) suggestion = "request_changes";
  else if (nothingRun) suggestion = "run_checks";
  else if (concerns.length > 0 || notRun.length > 0) suggestion = "review_deeper";
  else suggestion = "approve";
  return { suggestion, blockers, concerns, notRun };
}

/** A comment a "request changes" review can carry, drafted from the report. */
export interface DraftComment {
  /** Built from what the comment is about, so it names the same comment when the report refreshes. */
  id: string;
  /** Where it came from, as the report labels it. */
  source: string;
  title: string;
  /** The comment text, made safe to post; the reviewer can edit it. */
  body: string;
  severity: Severity;
  /** With both, it goes on its line; without, into the review's summary. */
  path?: string;
  line?: number;
  /** Ticked at first: the ones a reviewer would almost always raise. */
  pickedByDefault: boolean;
}

interface DraftInput {
  section: string;
  source: string;
  title: string;
  detail: string;
  severity: Severity;
  path?: string;
  line?: number;
  pickedByDefault: boolean;
}

/**
 * Comments for a "request changes" review: unmet claims, outlier questions,
 * unfinished work, high and medium findings, risk concerns, and failing CI.
 * Only results for the PR's head go on a line, since an older head's line
 * numbers may point at different code now; `currentSections` names those.
 */
export function draftComments(
  report: VerificationReport | null,
  evidence: readonly EvidenceItem[] | null,
  currentSections: ReadonlySet<string>,
): DraftComment[] {
  const drafts: DraftComment[] = [];
  const ids = new Set<string>();
  const add = ({ section, source, path, line, pickedByDefault, ...f }: DraftInput) => {
    const located = currentSections.has(section) && path && line;
    let id = `${section}:${path ?? ""}:${line ?? ""}:${f.title}`;
    // Two identical results would share an id; the second gets a suffix.
    for (let n = 2; ids.has(id); n++) id = `${id}#${n}`;
    ids.add(id);
    drafts.push({
      id,
      source,
      title: f.title,
      body: findingCommentBody(f, source),
      severity: f.severity,
      ...(located && { path, line }),
      pickedByDefault,
    });
  };

  if (report) {
    for (const c of report.claims?.items ?? []) {
      if (c.status === "verified" || c.status === "unverifiable") continue;
      const severity: Severity = c.status === "partial" ? "medium" : "high";
      add({
        section: "claims",
        source: `Claims: ${c.status}`,
        title: c.claim,
        detail: c.evidence,
        severity,
        path: c.path,
        line: c.line,
        pickedByDefault: severity === "high",
      });
    }
    for (const t of report.changeMap?.themes ?? []) {
      const first = t.files[0];
      if (t.cohesion !== "outlier" || !t.question || !first) continue;
      add({
        section: "changeMap",
        source: "Change map",
        title: t.title,
        detail: t.question,
        severity: "medium",
        path: first.path,
        line: first.lines?.start ?? 1,
        pickedByDefault: true,
      });
    }
    for (const g of report.claims?.gaps ?? []) {
      if (g.severity === "low") continue;
      add({
        ...g,
        section: "claims",
        source: "Unfinished work",
        pickedByDefault: g.severity === "high",
      });
    }
    for (const key of VERIFICATION_CHECKS) {
      for (const f of report[key]?.findings ?? []) {
        if (f.severity === "low") continue;
        add({
          ...f,
          section: key,
          source: CHECK_LABEL[key],
          pickedByDefault: f.severity === "high",
        });
      }
    }
    for (const c of report.risk?.concerns ?? []) {
      add({ ...c, section: "risk", source: "Risk", severity: "medium", pickedByDefault: false });
    }
  }

  // A failing check, for the summary. Its annotations are left out: they
  // already show on the PR's lines, where the check put them.
  for (const e of evidence?.find((i) => i.id === "ci-checks")?.entries ?? []) {
    if (e.severity !== "high" || e.path) continue;
    add({
      section: "evidence",
      source: "CI",
      title: e.title,
      detail: e.detail,
      severity: "high",
      pickedByDefault: true,
    });
  }
  return drafts;
}

/**
 * The review's summary: each picked comment with no line, whole, then how
 * many went on the diff. Each one's text is its draft's, which
 * `findingCommentBody` made safe to post, or the reviewer's own edit.
 */
export function reviewSummary(picked: readonly DraftComment[]): string {
  const onDiff = picked.filter((d) => d.path && d.line);
  const general = picked.filter((d) => !(d.path && d.line));
  const parts = ["Requesting changes based on the verification report."];
  parts.push(...general.map((d) => d.body));
  if (onDiff.length > 0) {
    parts.push(`${plural(onDiff.length, "more comment is", "more comments are")} on the diff.`);
  }
  return parts.join("\n\n");
}

/** A place to read when the answer is "review deeper", most important first. */
interface Place {
  path: string;
  line?: number;
  /** Why to look there. */
  reason: string;
}

/**
 * Where a closer look pays: outlier and high-risk themes, then the must-read
 * files, then each high finding's line. A file appears once, under its first
 * reason.
 */
export function whereToLook(report: VerificationReport | null): Place[] {
  if (!report) return [];
  const places: Place[] = [];
  const seen = new Set<string>();
  const add = (place: Place) => {
    if (seen.has(place.path)) return;
    seen.add(place.path);
    places.push(place);
  };
  const themes = report.changeMap?.themes ?? [];
  for (const t of themes.filter((t) => t.cohesion === "outlier")) {
    for (const f of t.files) {
      add({ path: f.path, line: f.lines?.start, reason: `Outlier: ${t.title}` });
    }
  }
  for (const t of themes.filter((t) => t.risk === "high" && t.cohesion !== "outlier")) {
    for (const f of t.files) {
      add({ path: f.path, line: f.lines?.start, reason: `High risk: ${t.title}` });
    }
  }
  for (const m of report.mustRead) add({ path: m.path, line: m.lines?.start, reason: m.reason });
  for (const key of VERIFICATION_CHECKS) {
    for (const f of report[key]?.findings ?? []) {
      if (f.severity === "high" && f.path) {
        add({ path: f.path, line: f.line, reason: `${CHECK_LABEL[key]}: ${f.title}` });
      }
    }
  }
  return places;
}
