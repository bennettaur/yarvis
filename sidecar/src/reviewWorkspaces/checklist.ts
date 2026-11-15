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
  completeness: {
    theme: "correctness",
    label: "Completeness",
    description: "Whether the code does everything the PR says it does.",
  },
  tests: {
    theme: "correctness",
    label: "Test quality",
    description: "Whether the tests cover the change and would catch it breaking.",
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

  const results = await loadResults(
    db,
    rows.filter((r) => r.status === "succeeded").map((r) => r.id),
  );
  const items: ChecklistItem[] = [];
  const answers: SectionAnswer[] = [];
  for (const section of REPORT_SECTIONS) {
    const covering = rows.filter((r) => runSections(r.meta).includes(section));
    const latest = covering[0];
    // A run older than the section's field (or one whose answer was cut short) has nothing for it.
    const answered = covering.find(
      (r) => r.status === "succeeded" && results.get(r.id)?.[section] !== undefined,
    );
    const result = answered ? toRun(answered) : null;
    items.push({
      section,
      ...CHECKLIST_ENTRIES[section],
      latest: latest ? toRun(latest) : null,
      result,
    });
    const stored = answered && results.get(answered.id);
    if (result && stored) {
      answers.push({
        section,
        headSha: result.headSha,
        runId: result.id,
        startedAt: result.startedAt,
        stored,
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
  };
}

async function loadResults(db: Db, ids: string[]): Promise<Map<string, CoveredReport>> {
  if (ids.length === 0) return new Map();
  const rows = await db
    .select({ id: agentRuns.id, result: agentRuns.result })
    .from(agentRuns)
    .where(inArray(agentRuns.id, ids));
  return new Map(
    rows.filter((r) => r.result !== null).map((r) => [r.id, r.result as CoveredReport]),
  );
}

export interface SectionAnswer {
  section: ReportSection;
  headSha: string | null;
  runId: string;
  startedAt: Date;
  stored: CoveredReport;
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
  for (const { section, headSha: at, stored } of answers) {
    const part = byHead.get(at) ?? {};
    if (section === "summary") {
      part.summary = stored.summary;
      part.mustRead = stored.mustRead ?? [];
    } else {
      // The stored answer was validated for this section when its run ended.
      (part as Record<string, unknown>)[section] = stored[section];
    }
    byHead.set(at, part);
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
  const coverage = mergeCoverage(
    [...new Set(counted.map((a) => a.runId))].map(
      (id) => counted.find((a) => a.runId === id)?.stored.coverage,
    ),
  );
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
