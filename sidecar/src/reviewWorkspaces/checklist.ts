/**
 * The verification checklist: every section of the report as an item the
 * reviewer runs when they choose, grouped by theme, with each one's latest run
 * and newest result. The report shown under it is put together from those
 * results, so a section re-run alone replaces only its own part.
 */

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns } from "../db/schema.ts";
import { describeError } from "../llm/errors.ts";
import type { VerificationRunConfig } from "../pr/models.ts";
import type { Coverage, UnknownCoverage } from "./coverage.ts";
import { PATCH_LIMITS } from "./patchFiles.ts";
import { getReviewPr, type ReviewDeps, reviewDiffFacts } from "./service.ts";
import {
  CHECK_SECTIONS,
  type CoveredReport,
  crossCheck,
  emptyAudit,
  REPORT_SECTIONS,
  type ReportSection,
  runSections,
  VERIFICATION_RUN_KIND,
  type VerificationReport,
  type VerificationSize,
  verificationSize,
} from "./verification.ts";

export const CHECKLIST_THEMES = [
  { id: "understand", label: "Understand the change" },
  { id: "correctness", label: "Correctness and tests" },
  { id: "risk", label: "Risk and impact" },
  { id: "maintainability", label: "Maintainability" },
] as const;

export type ChecklistTheme = (typeof CHECKLIST_THEMES)[number]["id"];

interface ChecklistEntry {
  theme: ChecklistTheme;
  label: string;
  description: string;
}

/** What each section is called on the checklist and what it checks. */
export const CHECKLIST_ENTRIES: Record<ReportSection, ChecklistEntry> = {
  summary: {
    theme: "understand",
    label: "Summary and must-read files",
    description: "What the change does, and which files to read first and why.",
  },
  flow: {
    theme: "understand",
    label: "Flow diagram",
    description: "The whole flow the change sits in, from what starts it to where it ends.",
  },
  changeMap: {
    theme: "understand",
    label: "Change map",
    description:
      "The change grouped into themes, each with its risk and how it fits the PR's goal; outliers come with a question for the author.",
  },
  claims: {
    theme: "correctness",
    label: "Claims",
    description:
      "What the title, description and linked tickets say the PR does, each checked against the code, and unfinished work.",
  },
  tests: {
    theme: "correctness",
    label: "Test quality",
    description: "Whether the tests cover the change and would catch it breaking.",
  },
  bugs: {
    theme: "correctness",
    label: "Bugs",
    description:
      "Inputs or timing that make the changed code do the wrong thing, traps it sets for the next change, and existing bugs it now reaches.",
  },
  performance: {
    theme: "correctness",
    label: "Performance",
    description: "Slow paths, repeated queries and wasted work in the changed code.",
  },
  observability: {
    theme: "correctness",
    label: "Observability",
    description: "Swallowed errors, wrong log levels, sensitive data in logs, missing metrics.",
  },
  risk: {
    theme: "risk",
    label: "Risk",
    description: "How likely the change is to break something, and how far that would spread.",
  },
  malice: {
    theme: "risk",
    label: "Malicious intent",
    description:
      "Backdoors, data sent somewhere new, hidden text, tampered tests, and changes to CI, build or install scripts, judged without the PR's description.",
  },
  complexity: {
    theme: "maintainability",
    label: "Complexity",
    description: "Code more complex than the problem needs.",
  },
  quality: {
    theme: "maintainability",
    label: "Code quality",
    description: "The language's and the codebase's own practice, error handling and naming.",
  },
  comments: {
    theme: "maintainability",
    label: "Comment quality",
    description: "Comments that are wrong, out of date or only restate the code.",
  },
  improvements: {
    theme: "maintainability",
    label: "Improvements",
    description:
      "Refactors and design changes the PR points to, such as a root cause it works around, as follow-ups rather than blockers.",
  },
  approach: {
    theme: "maintainability",
    label: "Simpler approach",
    description: "Whether there is a simpler way to do what the PR does.",
  },
};

/** A run on the checklist: enough to show its state, without its answer or events. */
export interface ChecklistRun {
  id: string;
  status: string;
  /** Whether this sidecar is running it, so its events can be followed live. */
  live: boolean;
  /** The commit it ran against. */
  headSha: string | null;
  /** True when that is the PR's head now. */
  current: boolean;
  error: string | null;
  costUsd: number | null;
  startedAt: Date;
  finishedAt: Date | null;
}

export interface ChecklistItem extends ChecklistEntry {
  section: ReportSection;
  /** The newest run that wrote this section, whatever its outcome. */
  latest: ChecklistRun | null;
  /** The newest run that answered for this section, which the report shows. */
  result: ChecklistRun | null;
}

/** The report put together from each section's newest result. */
export type ChecklistReport = VerificationReport & { coverage?: Coverage | UnknownCoverage };

export interface VerificationChecklist {
  /** The PR's head now. */
  headSha: string | null;
  themes: typeof CHECKLIST_THEMES;
  /** In report order. */
  items: ChecklistItem[];
  /** Null until some section has a result. */
  report: ChecklistReport | null;
  /**
   * The PR's size, for saying what the agents won't read whole. Null until the
   * PR is ready to read.
   */
  size: VerificationSize | null;
  /** The tickets the reviewer named for the newest run that read tickets, to offer again. */
  namedTickets: string[];
}

/** More runs than any PR's checklist needs, so a PR re-run for months can't make the read unbounded. */
const MAX_RUNS_READ = 300;

type RunRow = Omit<ChecklistRun, "live" | "current" | "headSha"> & {
  meta: Record<string, unknown>;
};

/**
 * The PR's checklist: each section's latest run and newest result, and the
 * report those results make.
 */
export async function verificationChecklist(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  reviewDeps: ReviewDeps,
  isLive: (id: string) => boolean,
  settings: () => Promise<VerificationRunConfig>,
): Promise<VerificationChecklist> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const rows: RunRow[] = await db
    .select({
      id: agentRuns.id,
      status: agentRuns.status,
      error: agentRuns.error,
      costUsd: agentRuns.costUsd,
      startedAt: agentRuns.startedAt,
      finishedAt: agentRuns.finishedAt,
      meta: agentRuns.meta,
    })
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.kind, VERIFICATION_RUN_KIND),
        sql`${agentRuns.meta}->>'refKey' = ${pr.refKey}`,
      ),
    )
    .orderBy(desc(agentRuns.startedAt))
    .limit(MAX_RUNS_READ);

  const toRun = (row: RunRow): ChecklistRun => {
    const { meta, ...rest } = row;
    const headSha = typeof meta.headSha === "string" ? meta.headSha : null;
    return {
      ...rest,
      live: isLive(row.id),
      headSha,
      current: headSha !== null && headSha === pr.headSha,
    };
  };

  const results = await newestAnswers(db, rows);
  const items: ChecklistItem[] = [];
  const answers: SectionAnswer[] = [];
  for (const section of REPORT_SECTIONS) {
    const latest = rows.find((r) => runSections(r.meta).includes(section));
    const answer = results.get(section);
    const result = answer ? toRun(answer.row) : null;
    items.push({
      section,
      ...CHECKLIST_ENTRIES[section],
      latest: latest ? toRun(latest) : null,
      result,
    });
    if (answer && result) {
      answers.push({
        section,
        headSha: result.headSha,
        runId: result.id,
        startedAt: result.startedAt,
        report: answer.report,
      });
    }
  }

  let size: VerificationSize | null = null;
  if (pr.status === "ready") {
    // A cached read once the PR has been opened. A failure only costs the notices.
    try {
      const [{ files, truncated, bulk }, runConfig] = await Promise.all([
        reviewDiffFacts(db, config, workspaceId, prId, reviewDeps, PATCH_LIMITS.maxPatchBytes),
        settings(),
      ]);
      size = verificationSize(files, truncated, bulk, runConfig);
    } catch (e) {
      console.error("[verification] could not size the PR:", describeError(e));
    }
  }

  return {
    headSha: pr.headSha,
    themes: CHECKLIST_THEMES,
    items,
    report: assembleReport(answers, pr.headSha),
    size,
    namedTickets: lastNamedTickets(rows),
  };
}

/** The tickets named for the newest run that recorded any, as the reviewer typed them. */
function lastNamedTickets(rows: RunRow[]): string[] {
  for (const row of rows) {
    const named = row.meta.namedTickets;
    if (Array.isArray(named)) return named.filter((t): t is string => typeof t === "string");
  }
  return [];
}

/**
 * Whether a stored report has an answer for `section` in the shape the report
 * view reads. A run that succeeded without one (an older run, or an answer
 * cut short) is passed over, and so is one stored under an older shape.
 */
function hasAnswer(report: CoveredReport, section: ReportSection): boolean {
  const value: unknown = report[section];
  if (section === "summary") return typeof value === "string";
  if (typeof value !== "object" || value === null) return false;
  return (
    !(CHECK_SECTIONS as readonly string[]).includes(section) ||
    Array.isArray((value as { findings?: unknown }).findings)
  );
}

/**
 * Each section's newest succeeded run with an answer for it. Stored reports
 * are big, so they are loaded a round at a time: each section's next
 * candidate, newest first, until every section has an answer or runs out.
 */
async function newestAnswers(
  db: Db,
  rows: RunRow[],
): Promise<Map<ReportSection, { row: RunRow; report: CoveredReport }>> {
  const candidates = REPORT_SECTIONS.map((section) => ({
    section,
    runs: rows.filter((r) => r.status === "succeeded" && runSections(r.meta).includes(section)),
    next: 0,
  }));
  const loaded = new Map<string, CoveredReport | null>();
  const found = new Map<ReportSection, { row: RunRow; report: CoveredReport }>();
  for (;;) {
    const wanted = new Set<string>();
    for (const candidate of candidates) {
      const { section, runs } = candidate;
      while (!found.has(section) && candidate.next < runs.length) {
        const row = runs[candidate.next] as RunRow;
        if (!loaded.has(row.id)) {
          wanted.add(row.id);
          break;
        }
        const report = loaded.get(row.id);
        if (report && hasAnswer(report, section)) found.set(section, { row, report });
        else candidate.next++;
      }
    }
    if (wanted.size === 0) return found;
    const fetched = await db
      .select({ id: agentRuns.id, result: agentRuns.result })
      .from(agentRuns)
      .where(inArray(agentRuns.id, [...wanted]));
    for (const id of wanted) {
      const row = fetched.find((r) => r.id === id);
      loaded.set(id, (row?.result as CoveredReport | null | undefined) ?? null);
    }
  }
}

export interface SectionAnswer {
  section: ReportSection;
  headSha: string | null;
  runId: string;
  startedAt: Date;
  /** The run's stored report, which has an answer for `section`. */
  report: CoveredReport;
}

/** A stored report's answer for one section, as the report's fields. */
function sectionOf(stored: CoveredReport, section: ReportSection): VerificationReport {
  if (section === "summary") return { summary: stored.summary, mustRead: stored.mustRead ?? [] };
  return { [section]: stored[section] };
}

/**
 * The report from each section's newest answer. Answers made at the same
 * commit are checked against each other, so a problem two sections reported
 * shows once; answers from different commits are left alone, since their
 * line numbers may not match. Coverage is counted over the answers at the
 * PR's head, or, when none are, at the newest answer's commit.
 */
export function assembleReport(
  answers: SectionAnswer[],
  headSha: string | null,
): ChecklistReport | null {
  if (answers.length === 0) return null;
  const byHead = new Map<string | null, VerificationReport>();
  for (const { section, headSha: answeredAt, report: stored } of answers) {
    const part = byHead.get(answeredAt) ?? {};
    byHead.set(answeredAt, { ...part, ...sectionOf(stored, section) });
  }
  let report: VerificationReport = {};
  for (const part of byHead.values()) {
    report = { ...report, ...crossCheck(part, emptyAudit()) };
  }

  const atHead = answers.some((a) => a.headSha === headSha);
  const countedAt = atHead
    ? headSha
    : answers.reduce((a, b) => (b.startedAt > a.startedAt ? b : a)).headSha;
  const counted = answers.filter((a) => a.headSha === countedAt);
  // One coverage per run: an old run can answer for several sections.
  const coverageByRun = new Map(counted.map((a) => [a.runId, a.report.coverage]));
  const coverage = mergeCoverage([...coverageByRun.values()]);
  return { ...report, ...(coverage && { coverage }) };
}

/**
 * What a set of runs at one commit read between them. A file counts as
 * examined when any run examined it, skimmed when any skimmed it and none
 * examined it, and not examined only when no run did either. A run whose
 * count is unknown is left out, so its reads count for nothing.
 */
export function mergeCoverage(
  coverages: (Coverage | UnknownCoverage | undefined)[],
): Coverage | UnknownCoverage | undefined {
  const present = coverages.filter((c): c is Coverage | UnknownCoverage => c !== undefined);
  if (present.length === 0) return undefined;
  const known = present.filter((c): c is Coverage => !("unknown" in c));
  if (known.length === 0) return { unknown: true };
  const total = Math.max(...known.map((c) => c.total));
  const examinedBy = (c: Coverage, path: string) =>
    !c.notExamined.some((n) => n.path === path) && !c.skimmed.some((s) => s.path === path);
  const listed = new Set(known.flatMap((c) => [...c.notExamined, ...c.skimmed].map((e) => e.path)));
  const skimmed: Coverage["skimmed"] = [];
  const notExamined: Coverage["notExamined"] = [];
  for (const path of listed) {
    if (known.some((c) => examinedBy(c, path))) continue;
    const skim = known.flatMap((c) => c.skimmed).find((s) => s.path === path);
    if (skim) skimmed.push(skim);
    else {
      const first = known.flatMap((c) => c.notExamined).find((n) => n.path === path);
      if (first) notExamined.push(first);
    }
  }
  return {
    examined: total - skimmed.length - notExamined.length,
    total,
    skimmed,
    notExamined,
    laneGaps: known.flatMap((c) => c.laneGaps),
  };
}
