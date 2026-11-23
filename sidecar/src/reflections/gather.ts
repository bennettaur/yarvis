import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { createGitHubClient, type ReviewContributions } from "../github/client.ts";
import type { PrDetail, PrSummary, ReviewComment } from "../pr/types.ts";
import { refKey } from "../pr/types.ts";
import { type ChecklistReport, storedReportFor } from "../reviewWorkspaces/checklist.ts";
import { CHECK_SECTIONS } from "../reviewWorkspaces/verification.ts";
import {
  type DraftOutcome,
  loadDraftOutcomes,
  loadRootCauseNotes,
  type RootCauseNote,
} from "./seams.ts";

/**
 * The facts a weekly reflection works from, gathered in code so the routine's
 * model only has to judge them. Every string a person wrote is plain here; the
 * tools that hand this to a model fence it.
 */

/** How far apart two lines in one file can be and still count as the same spot. */
export const LINE_WINDOW = 5;

const MAX_PRS = 15;
const MAX_COMMENTS_PER_PR = 30;
const MAX_FLAGS_PER_PR = 30;
const COMMENT_CHARS = 600;

export interface Flag {
  /** The report section that raised it, e.g. `tests` or `claims`. */
  section: string;
  severity: string;
  title: string;
  path: string | null;
  line: number | null;
  /** Whether a comment landed on the same file near the same line. */
  matched: boolean;
}

export interface Comment {
  author: string;
  path: string | null;
  line: number | null;
  body: string;
  /** Whether a flag sits on the same file near the same line. */
  matched: boolean;
}

export interface ReflectedPr {
  ref: string;
  url: string;
  title: string;
  /** `none` when verification never ran on it, so nothing can be said about what it missed. */
  verification: "report" | "none";
  comments: Comment[];
  flags: Flag[];
  truncated: boolean;
}

export interface ReflectionWindow {
  from: string;
  to: string;
}

export interface ReviewReflectionData {
  window: ReflectionWindow;
  prs: ReflectedPr[];
  /** Verified PRs only: comments on spots no flag covers. */
  unmatchedComments: number;
  /** Verified PRs only: flags with no comment of the user's near them. */
  flagsWithoutComment: number;
  draftOutcomes: DraftOutcome[];
  unavailable: string[];
}

export interface GenerationReflectionData {
  window: ReflectionWindow;
  prs: ReflectedPr[];
  unmatchedComments: number;
  flagsWithoutComment: number;
  rootCauses: RootCauseNote[];
  unavailable: string[];
}

/** The GitHub calls a reflection makes, so a test can stand in. */
export interface ReflectionGithub {
  viewer(): Promise<{ login: string }>;
  reviewContributions(from: Date, to: Date): Promise<ReviewContributions>;
  search(query: string): Promise<PrSummary[]>;
  prDetail(owner: string, repo: string, number: number): Promise<PrDetail>;
}

export interface ReflectionDeps {
  github?: ReflectionGithub;
  /** The newest verification report for a PR, by `refKey`. */
  report?: (refKey: string) => Promise<ChecklistReport | null>;
  now?: () => Date;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function windowOf(now: Date, days: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

function clip(text: string): string {
  return text.length > COMMENT_CHARS ? `${text.slice(0, COMMENT_CHARS)}…` : text;
}

/** The report's findings and claim gaps as flat flags. */
export function flagsOf(report: ChecklistReport | null): Omit<Flag, "matched">[] {
  if (!report) return [];
  const out: Omit<Flag, "matched">[] = [];
  const add = (
    section: string,
    findings: { title: string; severity: string; path?: string; line?: number }[] | undefined,
  ) => {
    for (const f of findings ?? []) {
      out.push({
        section,
        severity: f.severity,
        title: f.title,
        path: f.path ?? null,
        line: f.line ?? null,
      });
    }
  };
  for (const key of CHECK_SECTIONS) add(key, report[key]?.findings);
  add("claims", report.claims?.gaps);
  return out;
}

/** Whether two spots are the same file with lines within the window; no line on either side means the file alone. */
export function sameSpot(
  a: { path: string | null; line: number | null },
  b: { path: string | null; line: number | null },
): boolean {
  if (!a.path || a.path !== b.path) return false;
  if (a.line === null || b.line === null) return true;
  return Math.abs(a.line - b.line) <= LINE_WINDOW;
}

function commentsOf(detail: PrDetail, keep: (c: ReviewComment) => boolean): Comment[] {
  const out: Comment[] = [];
  for (const thread of detail.reviewThreads) {
    for (const c of thread.comments) {
      if (!keep(c)) continue;
      out.push({
        author: c.author,
        path: thread.path,
        line: thread.line,
        body: clip(c.body),
        matched: false,
      });
    }
  }
  for (const c of detail.conversation ?? []) {
    if (!keep(c)) continue;
    out.push({ author: c.author, path: null, line: null, body: clip(c.body), matched: false });
  }
  return out;
}

async function reflectOn(
  summary: { owner: string; repo: string; number: number; url: string },
  detail: PrDetail,
  keep: (c: ReviewComment) => boolean,
  loadReport: (refKey: string) => Promise<ChecklistReport | null>,
): Promise<ReflectedPr> {
  const key = refKey({
    provider: "github",
    owner: summary.owner,
    repo: summary.repo,
    number: summary.number,
  });
  const report = await loadReport(key).catch((e) => {
    console.error("[reflection] could not read a verification report:", e);
    return null;
  });
  const comments = commentsOf(detail, keep);
  const flags: Flag[] = flagsOf(report).map((f) => ({ ...f, matched: false }));
  for (const comment of comments) {
    for (const flag of flags) {
      if (sameSpot(comment, flag)) {
        comment.matched = true;
        flag.matched = true;
      }
    }
  }
  return {
    ref: `${summary.owner}/${summary.repo}#${summary.number}`,
    url: summary.url,
    title: detail.title,
    verification: report ? "report" : "none",
    comments: comments.slice(0, MAX_COMMENTS_PER_PR),
    flags: flags.slice(0, MAX_FLAGS_PER_PR),
    truncated:
      detail.reviewThreadsTruncated === true ||
      comments.length > MAX_COMMENTS_PER_PR ||
      flags.length > MAX_FLAGS_PER_PR,
  };
}

function totals(prs: ReflectedPr[]) {
  const verified = prs.filter((p) => p.verification === "report");
  return {
    unmatchedComments: verified.flatMap((p) => p.comments).filter((c) => !c.matched).length,
    flagsWithoutComment: verified.flatMap((p) => p.flags).filter((f) => !f.matched).length,
  };
}

function clientFor(config: Config, deps: ReflectionDeps): ReflectionGithub | null {
  if (deps.github) return deps.github;
  const token = config.secrets?.githubToken;
  return token ? createGitHubClient(config, token) : null;
}

/**
 * The PRs the user reviewed in the window, with the comments they left and what
 * verification flagged on each. A comment and a flag match when they sit on the
 * same file within {@link LINE_WINDOW} lines; the routine's model judges the
 * rest by meaning.
 */
export async function gatherReviewReflection(
  db: Db,
  config: Config,
  options: { days: number },
  deps: ReflectionDeps = {},
): Promise<ReviewReflectionData> {
  const { from, to } = windowOf((deps.now ?? (() => new Date()))(), options.days);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const github = clientFor(config, deps);
  if (!github) {
    return {
      window,
      prs: [],
      unmatchedComments: 0,
      flagsWithoutComment: 0,
      draftOutcomes: [],
      unavailable: ["github (not signed in)"],
    };
  }
  const loadReport = deps.report ?? ((key: string) => storedReportFor(db, key));
  const { login } = await github.viewer();
  const { contributions, truncated } = await github.reviewContributions(from, to);
  const unavailable = truncated
    ? ["some reviews (GitHub's contribution window was cut short)"]
    : [];

  const seen = new Set<string>();
  const targets = contributions.filter((c) => {
    const key = `${c.owner}/${c.repo}#${c.number}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  if (targets.length > MAX_PRS) unavailable.push(`${targets.length - MAX_PRS} older reviewed PRs`);

  const prs: ReflectedPr[] = [];
  for (const target of targets.slice(0, MAX_PRS)) {
    try {
      const detail = await github.prDetail(target.owner, target.repo, target.number);
      if (detail.author === login) continue;
      const url = `https://github.com/${target.owner}/${target.repo}/pull/${target.number}`;
      prs.push(await reflectOn({ ...target, url }, detail, (c) => c.author === login, loadReport));
    } catch (e) {
      console.error("[reflection] could not read a reviewed PR:", e);
      unavailable.push(`${target.owner}/${target.repo}#${target.number}`);
    }
  }
  const draftOutcomes = await loadDraftOutcomes(
    db,
    prs.map((p) => p.ref),
    from,
  );
  return { window, prs, ...totals(prs), draftOutcomes, unavailable };
}

/**
 * The user's PRs merged in the window, with the review comments other people
 * left and what verification flagged. Bot comments are left out.
 */
export async function gatherGenerationReflection(
  db: Db,
  config: Config,
  options: { days: number },
  deps: ReflectionDeps = {},
): Promise<GenerationReflectionData> {
  const { from, to } = windowOf((deps.now ?? (() => new Date()))(), options.days);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const rootCauses = await loadRootCauseNotes(db, from);
  const github = clientFor(config, deps);
  if (!github) {
    return {
      window,
      prs: [],
      unmatchedComments: 0,
      flagsWithoutComment: 0,
      rootCauses,
      unavailable: ["github (not signed in)"],
    };
  }
  const loadReport = deps.report ?? ((key: string) => storedReportFor(db, key));
  const { login } = await github.viewer();
  const since = from.toISOString().slice(0, 10);
  const found = await github.search(
    `is:pr is:merged author:${login} merged:>=${since} archived:false`,
  );
  const unavailable: string[] = [];
  if (found.length > MAX_PRS) unavailable.push(`${found.length - MAX_PRS} more merged PRs`);

  const prs: ReflectedPr[] = [];
  for (const summary of found.slice(0, MAX_PRS)) {
    try {
      const detail = await github.prDetail(summary.owner, summary.repo, summary.number);
      prs.push(await reflectOn(summary, detail, (c) => c.author !== login && !c.isBot, loadReport));
    } catch (e) {
      console.error("[reflection] could not read a merged PR:", e);
      unavailable.push(`${summary.owner}/${summary.repo}#${summary.number}`);
    }
  }
  return { window, prs, ...totals(prs), rootCauses, unavailable };
}
