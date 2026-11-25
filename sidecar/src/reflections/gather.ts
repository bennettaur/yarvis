import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { createGitHubClient, type ReviewContributions } from "../github/client.ts";
import { describeError } from "../llm/errors.ts";
import type { PrDetail, PrSummary, ReviewComment } from "../pr/types.ts";
import { parseRefKey, refKey } from "../pr/types.ts";
import { type ChecklistReport, storedReportFor } from "../reviewWorkspaces/checklist.ts";
import { feedbackSince, type ReportFeedback } from "../reviewWorkspaces/feedback.ts";
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
/** Most feedback rows a reflection reads, newest first, so the prompt stays a size a model can weigh. */
const MAX_FEEDBACK = 120;
/** The report's own text is context for the verdict, so less of it is kept than of a comment. */
const FEEDBACK_ITEM_CHARS = 300;

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

/** The user's judgement of one report item, as they gave it in the review workspace. */
export interface ItemFeedback {
  pr: string;
  section: string;
  /** What the item was: a finding, a claim gap, a risk concern, a must-read, and so on. */
  kind: string;
  title: string;
  detail: string;
  path: string | null;
  line: number | null;
  /** The severity or risk level the report gave it. */
  reportRating: string | null;
  verdict: "accepted" | "rejected" | "rerated" | null;
  /** For `rerated`: the level the user would give it. */
  rating: string | null;
  /** The user's own reason, when they gave one. */
  reason: string | null;
  /** What they did with it: posted it on the PR, added it to the workspace, asked about it. */
  actions: string[];
}

/** One section's verdicts and actions, counted over the feedback returned. */
export interface FeedbackTally {
  section: string;
  accepted: number;
  rejected: number;
  rerated: number;
  posted: number;
  asked: number;
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
  /** The user's item-by-item feedback on reports in the window, on any PR. */
  reportFeedback: ItemFeedback[];
  feedbackBySection: FeedbackTally[];
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
  /** The feedback given since a date, newest first. */
  feedback?: (since: Date) => Promise<{ feedback: ReportFeedback[]; truncated: boolean }>;
  now?: () => Date;
}

export function nowOf(deps: ReflectionDeps): Date {
  return (deps.now ?? (() => new Date()))();
}

const prLabel = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;

const DAY_MS = 24 * 60 * 60 * 1000;

function windowOf(now: Date, days: number): { from: Date; to: Date } {
  return { from: new Date(now.getTime() - days * DAY_MS), to: now };
}

function clip(text: string, max = COMMENT_CHARS): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function labelOfRefKey(key: string): string {
  const ref = parseRefKey(key);
  return ref?.provider === "github" ? prLabel(ref.owner, ref.repo, ref.number) : key;
}

function itemFeedbackOf(row: ReportFeedback): ItemFeedback {
  return {
    pr: labelOfRefKey(row.refKey),
    section: row.section,
    kind: row.kind,
    title: row.item.title,
    detail: clip(row.item.detail, FEEDBACK_ITEM_CHARS),
    path: row.item.path ?? null,
    line: row.item.line ?? null,
    reportRating: row.item.rating ?? null,
    verdict: row.verdict,
    rating: row.rating,
    reason: row.reason,
    actions: row.actions,
  };
}

/** Counts per section, in the order sections first appear. */
export function tallyFeedback(items: ItemFeedback[]): FeedbackTally[] {
  const bySection = new Map<string, FeedbackTally>();
  for (const item of items) {
    let tally = bySection.get(item.section);
    if (!tally) {
      tally = { section: item.section, accepted: 0, rejected: 0, rerated: 0, posted: 0, asked: 0 };
      bySection.set(item.section, tally);
    }
    if (item.verdict) tally[item.verdict] += 1;
    if (item.actions.includes("posted-pr")) tally.posted += 1;
    if (item.actions.includes("asked")) tally.asked += 1;
  }
  return [...bySection.values()];
}

/** Read from the database, so it is there even when GitHub isn't. */
async function loadFeedback(db: Db, from: Date, deps: ReflectionDeps, unavailable: string[]) {
  const load = deps.feedback ?? ((since: Date) => feedbackSince(db, since, MAX_FEEDBACK));
  try {
    const { feedback, truncated } = await load(from);
    if (truncated) unavailable.push("older report feedback (only the newest is read)");
    const reportFeedback = feedback.map(itemFeedbackOf);
    return { reportFeedback, feedbackBySection: tallyFeedback(reportFeedback) };
  } catch (e) {
    console.error("[reflection] could not read report feedback:", describeError(e));
    unavailable.push("report feedback");
    return { reportFeedback: [], feedbackBySection: [] };
  }
}

/** The report's findings, claim gaps and risk concerns as flat flags. */
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
  // A concern has no severity of its own, so it takes the report's risk level.
  const level = report.risk?.level ?? "unrated";
  add(
    "risk",
    report.risk?.concerns.map((c) => ({ ...c, severity: level })),
  );
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
  const report = await loadReport(key);
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
    ref: prLabel(summary.owner, summary.repo, summary.number),
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

/** Counted over what is returned, so a PR marked `truncated` is undercounted. */
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
  const { from, to } = windowOf(nowOf(deps), options.days);
  const window = { from: from.toISOString(), to: to.toISOString() };
  const unavailable: string[] = [];
  const feedback = await loadFeedback(db, from, deps, unavailable);
  const github = clientFor(config, deps);
  if (!github) {
    return {
      window,
      prs: [],
      unmatchedComments: 0,
      flagsWithoutComment: 0,
      draftOutcomes: [],
      ...feedback,
      unavailable: [...unavailable, "github (not signed in)"],
    };
  }
  const loadReport = deps.report ?? ((key: string) => storedReportFor(db, key));
  const { login } = await github.viewer();
  const { contributions, truncated } = await github.reviewContributions(from, to);
  if (truncated) unavailable.push("some reviews (GitHub's contribution window was cut short)");

  const seen = new Set<string>();
  const targets = contributions.filter((c) => {
    const key = prLabel(c.owner, c.repo, c.number);
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
      console.error("[reflection] could not read a reviewed PR:", describeError(e));
      unavailable.push(prLabel(target.owner, target.repo, target.number));
    }
  }
  const draftOutcomes = await loadDraftOutcomes(
    db,
    prs.map((p) => p.ref),
    from,
  );
  return { window, prs, ...totals(prs), draftOutcomes, ...feedback, unavailable };
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
  const { from, to } = windowOf(nowOf(deps), options.days);
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
      console.error("[reflection] could not read a merged PR:", describeError(e));
      unavailable.push(prLabel(summary.owner, summary.repo, summary.number));
    }
  }
  return { window, prs, ...totals(prs), rootCauses, unavailable };
}
