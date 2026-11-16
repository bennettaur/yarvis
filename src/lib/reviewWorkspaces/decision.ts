/**
 * What the verification checklist adds up to: a suggested decision on the PR
 * with the reasons for it, the comments a "request changes" review would
 * carry, and where to look when the answer is "review deeper".
 *
 * The rules are deliberately few and visible: the panel shows every reason, so
 * the reviewer can see why it suggests what it does and disagree.
 */

import {
  type ChecklistItem,
  DEFAULT_SECTIONS,
  type EvidenceItem,
  findingCommentBody,
  type ReportSection,
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

/** Report sections that say something about whether to merge; the flow diagram doesn't. */
const JUDGED: readonly ReportSection[] = DEFAULT_SECTIONS.filter((s) => s !== "flow");

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function findingsBy(report: VerificationReport, severity: Severity): number {
  const inChecks = VERIFICATION_CHECKS.reduce(
    (n, key) => n + (report[key]?.findings.filter((f) => f.severity === severity).length ?? 0),
    0,
  );
  const inGaps = report.claims?.gaps.filter((g) => g.severity === severity).length ?? 0;
  return inChecks + inGaps;
}

/**
 * The suggested decision. Changes are needed when CI fails, a scanner raised a
 * high alert, a claim isn't met, or a check found something high. A closer look
 * is due for a risky change, an outlier, a partial claim, a medium finding or a
 * simpler approach. Approving is suggested only when the checks that judge the
 * PR have run on its head and none of that is there.
 */
export function assessReview(
  report: VerificationReport | null,
  evidence: readonly EvidenceItem[],
  items: readonly ChecklistItem[],
): Assessment {
  const blockers: string[] = [];
  const concerns: string[] = [];
  const notRun = items
    .filter((i) => JUDGED.includes(i.section) && !i.result?.current)
    .map((i) => i.label);

  const ci = evidence.find((e) => e.id === "ci-checks");
  if (ci?.tone === "bad") blockers.push(`CI: ${ci.summary}`);
  const scanning = evidence.find((e) => e.id === "code-scanning");
  const highAlerts = scanning?.entries.filter((e) => e.severity === "high").length ?? 0;
  if (highAlerts > 0)
    blockers.push(plural(highAlerts, "high code scanning alert", "high code scanning alerts"));
  const securityBots = evidence.find((e) => e.id === "security-bots");
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
    if (partial > 0)
      concerns.push(plural(partial, "claim only partly met", "claims only partly met"));

    const high = findingsBy(report, "high");
    if (high > 0) blockers.push(plural(high, "high finding", "high findings"));
    const medium = findingsBy(report, "medium");
    if (medium > 0) concerns.push(plural(medium, "medium finding", "medium findings"));

    const { risk } = report;
    if (risk && (risk.level === "high" || (risk.impact?.band ?? 0) >= 4)) {
      concerns.push(`High risk: ${risk.clientImpact}`);
    }
    const outliers = report.changeMap?.themes.filter((t) => t.cohesion === "outlier") ?? [];
    if (outliers.length > 0) {
      concerns.push(
        `${plural(outliers.length, "change doesn't", "changes don't")} belong to the PR's goal: ${outliers.map((t) => t.title).join(", ")}`,
      );
    }
    const rating = report.approach?.rating;
    if (rating === "simpler" || rating === "much-simpler") {
      concerns.push(
        rating === "much-simpler" ? "A much simpler way exists" : "A simpler way exists",
      );
    }
  }

  let suggestion: Suggestion;
  if (blockers.length > 0) suggestion = "request_changes";
  else if (notRun.length === JUDGED.length) suggestion = "run_checks";
  else if (concerns.length > 0 || notRun.length > 0) suggestion = "review_deeper";
  else suggestion = "approve";
  return { suggestion, blockers, concerns, notRun };
}

/** A comment a "request changes" review can carry, drafted from the report. */
export interface DraftComment {
  id: string;
  /** Where it came from, as the report labels it. */
  source: string;
  title: string;
  /** The comment text; the reviewer can edit it before posting. */
  body: string;
  severity: Severity;
  /** With both, it goes on its line; without, into the review's summary. */
  path?: string;
  line?: number;
  /** Ticked at first: the ones a reviewer would almost always raise. */
  picked: boolean;
}

/**
 * Comments for a "request changes" review: unmet claims, outlier questions,
 * high and medium findings and risk concerns, failing CI and scanner alerts.
 * Only results for the PR's head go on a line, since an older head's line
 * numbers may point at different code now; `currentSections` names those.
 */
export function draftComments(
  report: VerificationReport | null,
  evidence: readonly EvidenceItem[],
  currentSections: ReadonlySet<string>,
): DraftComment[] {
  const drafts: DraftComment[] = [];
  const add = (
    section: string,
    source: string,
    f: { title: string; detail: string; severity: Severity; path?: string; line?: number },
    picked: boolean,
  ) => {
    const located = currentSections.has(section) && f.path && f.line;
    drafts.push({
      id: `${section}:${drafts.length}`,
      source,
      title: f.title,
      body: findingCommentBody(f, source),
      severity: f.severity,
      ...(located && { path: f.path, line: f.line }),
      picked,
    });
  };

  if (report) {
    for (const c of report.claims?.items ?? []) {
      if (c.status === "verified" || c.status === "unverifiable") continue;
      const severity: Severity = c.status === "partial" ? "medium" : "high";
      add(
        "claims",
        `Claims: ${c.status}`,
        { title: c.claim, detail: c.evidence, severity, path: c.path, line: c.line },
        severity === "high",
      );
    }
    for (const t of report.changeMap?.themes ?? []) {
      const first = t.files[0];
      if (t.cohesion !== "outlier" || !t.question || !first) continue;
      add(
        "changeMap",
        "Change map",
        {
          title: t.title,
          detail: t.question,
          severity: "medium",
          path: first.path,
          line: first.lines?.start ?? 1,
        },
        true,
      );
    }
    for (const g of report.claims?.gaps ?? []) {
      if (g.severity !== "low") add("claims", "Unfinished work", g, g.severity === "high");
    }
    for (const key of VERIFICATION_CHECKS) {
      for (const f of report[key]?.findings ?? []) {
        if (f.severity !== "low") add(key, CHECK_SOURCE[key], f, f.severity === "high");
      }
    }
    for (const c of report.risk?.concerns ?? []) {
      add("risk", "Risk", { ...c, severity: "medium" }, false);
    }
  }

  // The provider's own results carry no head of ours, so none goes on a line.
  for (const e of evidence.find((i) => i.id === "ci-checks")?.entries ?? []) {
    if (e.severity === "high" && !e.path) {
      add("evidence", "CI", { title: e.title, detail: e.detail, severity: "high" }, true);
    }
  }
  return drafts;
}

const CHECK_SOURCE: Record<(typeof VERIFICATION_CHECKS)[number], string> = {
  tests: "Test quality",
  complexity: "Complexity",
  performance: "Performance",
  comments: "Comment quality",
  observability: "Observability",
  quality: "Code quality",
};

/**
 * The review's summary: the picked comments with no line, in full, and a
 * pointer to those posted on their lines.
 */
export function reviewSummary(picked: readonly DraftComment[]): string {
  const onLines = picked.filter((d) => d.path && d.line);
  const general = picked.filter((d) => !(d.path && d.line));
  const parts = ["Requesting changes, from the verification report."];
  if (general.length > 0) {
    parts.push(general.map((d) => `- **${d.title}** (${d.source})`).join("\n"));
  }
  if (onLines.length > 0) {
    parts.push(
      `${plural(onLines.length, "comment is", "comments are")} on the lines they're about.`,
    );
  }
  return parts.join("\n\n");
}

/** A place to read when the answer is "review deeper", most important first. */
export interface Place {
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
    for (const f of t.files)
      add({ path: f.path, line: f.lines?.start, reason: `Outlier: ${t.title}` });
  }
  for (const t of themes.filter((t) => t.risk === "high" && t.cohesion !== "outlier")) {
    for (const f of t.files)
      add({ path: f.path, line: f.lines?.start, reason: `High risk: ${t.title}` });
  }
  for (const m of report.mustRead) add({ path: m.path, line: m.lines?.start, reason: m.reason });
  for (const key of VERIFICATION_CHECKS) {
    for (const f of report[key]?.findings ?? []) {
      if (f.severity === "high" && f.path) {
        add({ path: f.path, line: f.line, reason: `${CHECK_SOURCE[key]}: ${f.title}` });
      }
    }
  }
  return places;
}
