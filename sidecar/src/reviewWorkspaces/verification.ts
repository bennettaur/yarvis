/**
 * The verification report: a headless Claude Code run over a review PR's
 * checkout that summarises the change, picks the files that must be read, and
 * runs the risk, completeness, test, complexity, performance and comment
 * checks — each a subagent of the `yarvis-review` plugin, fanned out by its
 * `verification-report` skill.
 *
 * Its whole point is to make a review faster, so the answer's shape is narrow
 * and bounded, and the bounds hold on the server too: what the model writes
 * past a limit is cut off rather than shown.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import {
  type AgentRunSummary,
  type ClaudeRunDeps,
  getAgentRunSummary,
  spotlight,
  startClaudeRun,
} from "../agentRuns/service.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentRuns, type ReviewWorkspacePr } from "../db/schema.ts";
import { createKeyedLock } from "../lib/keyedLock.ts";
import { describeError } from "../llm/errors.ts";
import { getVerificationRunConfig, type VerificationRunConfig } from "../pr/models.ts";
import { prSourceFor } from "../pr/source.ts";
import type { CheckItem, PrDetail, PrRef, ReviewThread } from "../pr/types.ts";
import type { ReviewChangedFile } from "./git.ts";
import {
  assertWorktreeInWorkspace,
  getReviewPr,
  type ReviewDeps,
  type ReviewPatch,
  ReviewWorkspaceError,
  reviewPatches,
} from "./service.ts";

export const VERIFICATION_RUN_KIND = "verification";

// ---------------------------------------------------------------------------
// The report's shape
// ---------------------------------------------------------------------------

/** Most findings a check reports, and most must-read files a report lists. */
export const MAX_FINDINGS = 5;
export const MAX_MUST_READ = 8;

const SEVERITIES = ["high", "medium", "low"] as const;
const SEVERITY_ORDER: Record<(typeof SEVERITIES)[number], number> = { high: 0, medium: 1, low: 2 };

/** Cuts text to `max` characters, ending in an ellipsis when it had to cut. */
function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Cuts text to `max` words. Ends at the last full sentence that fits when that
 * keeps most of the allowance, since a summary that stops mid-clause reads
 * worse than a shorter one; otherwise cuts mid-sentence and adds an ellipsis.
 */
export function clipWords(text: string, max: number): string {
  const words = text.trim().split(/\s+/).filter(Boolean);
  if (words.length <= max) return words.join(" ");
  const kept = words.slice(0, max);
  for (let end = kept.length; end >= Math.ceil(max / 2); end--) {
    if (/[.!?]["')\]]?$/.test(kept[end - 1] ?? "")) return kept.slice(0, end).join(" ");
  }
  return `${kept.join(" ")}…`;
}

/**
 * A string capped at `max` characters. The cap goes into the JSON Schema
 * Claude Code steers the model with, and is enforced here by cutting rather
 * than refusing: one over-long sentence shouldn't throw away a finished run.
 */
function boundedText(max: number) {
  return z
    .string()
    .transform((s) => clip(s, max))
    .meta({ maxLength: max });
}

/** An array capped at `max` items, the same way. */
function boundedList<T extends z.ZodType>(item: T, max: number) {
  return z
    .array(item)
    .transform((items) => items.slice(0, max))
    .meta({ maxItems: max });
}

/** Optional in the answer; models write null for "none" as often as they leave a key out. */
const optionalPath = z
  .string()
  .nullish()
  .transform((p) => (p?.trim() ? clip(p, 500) : undefined));

const optionalLine = z
  .number()
  .nullish()
  .transform((n) => (typeof n === "number" && Number.isInteger(n) && n > 0 ? n : undefined));

/** About 12 and 45 words: the agents are asked for at most 12 and 40. */
const TITLE_CHARS = 100;
const DETAIL_CHARS = 280;

const findingSchema = z.object({
  title: boundedText(TITLE_CHARS),
  detail: boundedText(DETAIL_CHARS),
  severity: z.enum(SEVERITIES),
  path: optionalPath,
  line: optionalLine,
});

/**
 * One check's verdict. The findings decide the status: a check that says
 * `issues` and lists none has nothing to show, and one that says `pass` while
 * listing findings would hide them.
 */
const checkSchema = z
  .object({
    status: z.enum(["pass", "issues"]),
    findings: boundedList(findingSchema, MAX_FINDINGS),
  })
  .transform(({ findings }) => {
    const sorted = [...findings].sort(
      (a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity],
    );
    return {
      status: sorted.length > 0 ? ("issues" as const) : ("pass" as const),
      findings: sorted,
    };
  });

const concernSchema = z.object({
  title: boundedText(TITLE_CHARS),
  detail: boundedText(DETAIL_CHARS),
  path: optionalPath,
  line: optionalLine,
});

const riskSchema = z.object({
  level: z.enum(["low", "medium", "high"]),
  clientImpact: boundedText(240),
  mitigations: boundedList(boundedText(100), 3),
  concerns: boundedList(concernSchema, MAX_FINDINGS),
});

const lineRangeSchema = z
  .object({ start: z.number().int().positive(), end: z.number().int().positive() })
  .nullish()
  .transform((r) =>
    r ? { start: Math.min(r.start, r.end), end: Math.max(r.start, r.end) } : undefined,
  );

const mustReadSchema = z.object({
  path: z.string().max(1000),
  reason: boundedText(160),
  lines: lineRangeSchema,
});

export interface ReportLimits {
  /** Most words the summary may have. */
  summaryWords: number;
  /** Most must-read files. */
  mustReadMax: number;
  /** The PR's changed paths; a must-read naming anything else is dropped. */
  changedPaths: ReadonlySet<string>;
}

/**
 * The report's schema for one PR. Built per run because its bounds come from
 * the PR: the summary's word cap from the diff size, the must-read list from
 * the changed files.
 */
export function verificationReportSchema(limits: ReportLimits) {
  return z.object({
    summary: z
      .string()
      .transform((s) => clipWords(s, limits.summaryWords))
      .meta({
        // Words aren't expressible in JSON Schema; this keeps the model near
        // the cap, and the transform holds it to it.
        maxLength: limits.summaryWords * 10,
        description: `At most ${limits.summaryWords} words.`,
      }),
    mustRead: boundedList(mustReadSchema, MAX_MUST_READ).transform((entries) => {
      const seen = new Set<string>();
      return entries
        .filter((e) => limits.changedPaths.has(e.path) && !seen.has(e.path) && seen.add(e.path))
        .slice(0, limits.mustReadMax);
    }),
    risk: riskSchema,
    completeness: checkSchema,
    tests: checkSchema,
    complexity: checkSchema,
    performance: checkSchema,
    comments: checkSchema,
  });
}

export type VerificationReport = z.output<ReturnType<typeof verificationReportSchema>>;

/**
 * The summary's word cap: about a word per three changed lines, between 25
 * and 80, so a summary is never longer than the change it describes.
 */
export function summaryWordCap(changedLines: number): number {
  return Math.min(80, Math.max(25, Math.ceil(changedLines / 3)));
}

/** About one must-read per three changed files, between 1 and {@link MAX_MUST_READ}. */
export function mustReadCap(changedFiles: number): number {
  return Math.min(MAX_MUST_READ, Math.max(1, Math.ceil(changedFiles / 3)));
}

// ---------------------------------------------------------------------------
// The prompt and the context the agents read
// ---------------------------------------------------------------------------

/** Longest description, comment and patch file the run is given. */
const MAX_DESCRIPTION_CHARS = 15_000;
const MAX_COMMENT_CHARS = 800;
const MAX_THREADS = 40;
const MAX_COMMENTS_PER_THREAD = 5;
export const PATCH_LIMITS = { maxFileBytes: 256 * 1024, maxTotalBytes: 3 * 1024 * 1024 };

export interface VerificationInput {
  ref: PrRef;
  headSha: string;
  /** Provider detail; null when it couldn't be loaded, which the prompt says. */
  detail: Pick<
    PrDetail,
    | "title"
    | "body"
    | "author"
    | "headRef"
    | "baseRef"
    | "checks"
    | "checksUnavailable"
    | "reviewThreads"
  > | null;
  /** The PR's title as cached on the row, for when `detail` is missing. */
  fallbackTitle: string;
  patches: ReviewPatch[];
}

export interface VerificationMaterial {
  prompt: string;
  /** `pr.md`: the same PR context, for the subagents, who don't see the prompt. */
  contextFile: string;
  /** `changes.diff`. */
  diffFile: string;
  limits: ReportLimits;
}

function checksBlock(detail: VerificationInput["detail"]): string {
  if (!detail) return "CI checks: unknown (the PR details could not be loaded).";
  const checks: CheckItem[] = detail.checks;
  const unavailable = detail.checksUnavailable
    ? " Some checks are hidden from the configured token, so this list is incomplete."
    : "";
  if (checks.length === 0) return `CI checks: none reported.${unavailable}`;
  const outcome = (c: CheckItem) =>
    c.status === "COMPLETED" ? (c.conclusion ?? "UNKNOWN").toLowerCase() : "pending";
  const counts = new Map<string, number>();
  for (const c of checks) counts.set(outcome(c), (counts.get(outcome(c)) ?? 0) + 1);
  const tally = [...counts].map(([k, n]) => `${n} ${k}`).join(", ");
  const list = checks.map((c) => `- ${c.name}: ${outcome(c)}`).join("\n");
  return `CI checks (${tally}).${unavailable}\n${spotlight("ci-checks", list)}`;
}

function threadsBlock(threads: ReviewThread[]): string {
  if (threads.length === 0) return "Review comments: none.";
  // Open threads first: they are where a reviewer's concern still stands.
  const ordered = [...threads].sort((a, b) => Number(a.isResolved) - Number(b.isResolved));
  const shown = ordered.slice(0, MAX_THREADS);
  const text = shown
    .map((t) => {
      const where = t.path ? `${t.path}${t.line ? `:${t.line}` : ""}` : "general";
      const comments = t.comments
        .slice(0, MAX_COMMENTS_PER_THREAD)
        .map((c) => `  ${c.author}: ${clip(c.body.replace(/\s+/g, " "), MAX_COMMENT_CHARS)}`)
        .join("\n");
      return `- [${t.isResolved ? "resolved" : "open"}] ${where}\n${comments}`;
    })
    .join("\n");
  const more =
    threads.length > shown.length ? ` ${threads.length - shown.length} more not shown.` : "";
  const open = threads.filter((t) => !t.isResolved).length;
  return `Review comments (${threads.length} threads, ${open} open).${more}\n${spotlight("review-comments", text)}`;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Prefixes every line of a hunk with the line number it has in its file: the
 * head's for added and context lines, the base's (marked `b`) for removed
 * ones. A model reading a diff cites the line numbers in front of it, and
 * without these those are the diff file's own, which point nowhere.
 */
export function numberPatch(patch: string): string {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const out: string[] = [];
  for (const line of patch.split("\n")) {
    const header = HUNK_HEADER.exec(line);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      out.push(line);
    } else if (!inHunk || line.startsWith("\\") || line === "") {
      out.push(line);
    } else if (line.startsWith("+")) {
      out.push(`+${String(newLine++).padStart(6)}  ${line.slice(1)}`);
    } else if (line.startsWith("-")) {
      out.push(`-${`b${oldLine++}`.padStart(6)}  ${line.slice(1)}`);
    } else if (line.startsWith(" ")) {
      oldLine++;
      out.push(` ${String(newLine++).padStart(6)}  ${line.slice(1)}`);
    } else {
      // The next file's header in a concatenated diff.
      inHunk = false;
      out.push(line);
    }
  }
  return out.join("\n");
}

/** The diff file, and the line each file's patch starts on in it. */
function diffAndIndex(patches: ReviewPatch[]): { diff: string; startLine: Map<string, number> } {
  const startLine = new Map<string, number>();
  const parts: string[] = [];
  let line = 1;
  for (const { file, patch } of patches) {
    if (patch === null) continue;
    startLine.set(file.path, line);
    const numbered = numberPatch(patch);
    const text = numbered.endsWith("\n") ? numbered : `${numbered}\n`;
    parts.push(text);
    line += text.split("\n").length - 1;
  }
  return { diff: parts.join(""), startLine };
}

function fileLine(
  file: ReviewChangedFile,
  omitted: ReviewPatch["omitted"],
  start?: number,
): string {
  const name = file.oldPath ? `${file.oldPath} -> ${file.path}` : file.path;
  const counts = file.binary ? "binary" : `+${file.additions} -${file.deletions}`;
  const where =
    omitted === "binary"
      ? "no diff (binary)"
      : omitted === "too-large"
        ? "no diff (too large to include)"
        : omitted === "over-budget"
          ? "no diff (the diff file is full; read the file itself)"
          : `changes.diff line ${start}`;
  return `- ${name} (${file.status}, ${counts}): ${where}`;
}

/**
 * Builds what a run is given. Every piece of text the PR's author or its
 * reviewers wrote — title, branch names, description, file paths, check names,
 * comments — goes in through {@link spotlight}; what sits outside the fences is
 * this function's own wording and numbers it computed.
 */
export function buildVerificationMaterial(
  input: VerificationInput,
  contextDir: string,
): VerificationMaterial {
  const { detail, patches } = input;
  // Only lines the run is shown count: a lockfile or generated bundle left out
  // for its size would otherwise buy a long summary of a small change.
  const changedLines = patches.reduce(
    (n, p) => n + (p.patch === null ? 0 : p.file.additions + p.file.deletions),
    0,
  );
  const limits: ReportLimits = {
    summaryWords: summaryWordCap(changedLines),
    mustReadMax: mustReadCap(patches.length),
    changedPaths: new Set(patches.map((p) => p.file.path)),
  };
  const { diff, startLine } = diffAndIndex(patches);

  const pr = detail
    ? [
        `Title: ${detail.title}`,
        `Author: ${detail.author}`,
        `Branch: ${detail.headRef} into ${detail.baseRef}`,
      ].join("\n")
    : `Title: ${input.fallbackTitle}`;
  const description = detail?.body.trim()
    ? spotlight("description", clip(detail.body, MAX_DESCRIPTION_CHARS))
    : detail
      ? "Description: none."
      : "Description: unknown (the PR details could not be loaded).";
  const files = patches
    .map((p) => fileLine(p.file, p.omitted, startLine.get(p.file.path)))
    .join("\n");

  const context = [
    `# Pull request at ${input.headSha}`,
    spotlight("pull-request", pr),
    description,
    `Changed files (${patches.length}; ${changedLines} changed lines in changes.diff).`,
    spotlight("changed-files", files || "(none)"),
    checksBlock(detail),
    threadsBlock(detail?.reviewThreads ?? []),
  ].join("\n\n");

  const prompt = [
    "Write the verification report for the pull request checked out in the working directory.",
    "Use the yarvis-review:verification-report skill and answer with its merged report.",
    "",
    `REVIEW_CONTEXT=${contextDir}`,
    `SUMMARY_WORDS=${limits.summaryWords}`,
    `MUST_READ_MAX=${limits.mustReadMax}`,
    "",
    "REVIEW_CONTEXT holds pr.md (the context below) and changes.diff (the diff from the merge-base to the head, each line numbered).",
    "",
    context,
  ].join("\n");

  return {
    prompt,
    contextFile: `${context}\n`,
    diffFile: diff,
    limits,
  };
}

// ---------------------------------------------------------------------------
// Starting and looking up runs
// ---------------------------------------------------------------------------

export interface VerificationDeps {
  /** The PR's description, checks and threads from its provider. */
  loadDetail(ref: PrRef): Promise<PrDetail>;
  settings(): Promise<VerificationRunConfig>;
  /** Passed to `startClaudeRun`; tests swap in a fake `claude`. */
  run?: ClaudeRunDeps;
}

export function defaultVerificationDeps(config: Config): VerificationDeps {
  return {
    async loadDetail(ref) {
      const source = prSourceFor(config, ref);
      if ("error" in source) throw new Error(source.error);
      return source.detail();
    },
    settings: getVerificationRunConfig,
  };
}

/** Read-only tools: the agents read the checkout and the context, and nothing else. */
const ALLOWED_TOOLS = ["Read", "Grep", "Glob", "Agent", "Skill"];
const DISALLOWED_TOOLS = ["Bash", "Write", "Edit", "NotebookEdit", "WebFetch", "WebSearch"];
const RUN_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_TURNS = 40;

function targetKeyFor(pr: Pick<ReviewWorkspacePr, "refKey">, headSha: string): string {
  return `${pr.refKey}@${headSha}`;
}

/** Runs for one PR (any head), newest first. */
async function latestRunId(db: Db, refKey: string, status?: string): Promise<string | null> {
  const conditions = [
    eq(agentRuns.kind, VERIFICATION_RUN_KIND),
    sql`starts_with(${agentRuns.targetKey}, ${`${refKey}@`})`,
  ];
  if (status) conditions.push(eq(agentRuns.status, status));
  const [row] = await db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(...conditions))
    .orderBy(desc(agentRuns.startedAt))
    .limit(1);
  return row?.id ?? null;
}

/** One check-and-start at a time per PR, so two clicks can't start two runs. */
const withPrLock = createKeyedLock();

export interface StartedVerification {
  runId: string;
  /** True when a run for this PR was already going and nothing new started. */
  existing: boolean;
}

/**
 * Starts a verification run for a review PR, or returns the one already
 * running for it (whatever head it was started at). Needs the worktree checked
 * out, since the agents read the files themselves.
 */
export async function startVerification(
  db: Db,
  config: Config,
  workspaceId: string,
  prId: string,
  reviewDeps: ReviewDeps,
  deps: VerificationDeps,
): Promise<StartedVerification> {
  const pr = await getReviewPr(db, workspaceId, prId);
  if (pr.status !== "ready" || pr.worktreeStatus !== "ready" || !pr.headSha) {
    const state = pr.status !== "ready" ? pr.status : pr.worktreeStatus;
    throw new ReviewWorkspaceError(`the checkout is ${state}, not ready`, 409);
  }
  assertWorktreeInWorkspace(config, pr);

  return withPrLock(pr.refKey, async () => {
    const running = await latestRunId(db, pr.refKey, "running");
    if (running) return { runId: running, existing: true };

    const [{ headSha, patches }, detail, settings] = await Promise.all([
      reviewPatches(db, config, workspaceId, prId, reviewDeps, PATCH_LIMITS),
      deps.loadDetail(pr.ref).catch((e) => {
        // The report is still worth having without the description and checks;
        // the prompt says they are missing so nothing reads their absence as
        // "none".
        console.error("[verification] could not load PR details:", describeError(e));
        return null;
      }),
      deps.settings(),
    ]);

    const contextDir = mkdtempSync(join(tmpdir(), "yarvis-verification-"));
    const removeContext = () => rmSync(contextDir, { recursive: true, force: true });
    try {
      const material = buildVerificationMaterial(
        { ref: pr.ref, headSha, detail, fallbackTitle: pr.title, patches },
        contextDir,
      );
      writeFileSync(join(contextDir, "pr.md"), material.contextFile);
      writeFileSync(join(contextDir, "changes.diff"), material.diffFile);
      const handle = await startClaudeRun(
        db,
        {
          kind: VERIFICATION_RUN_KIND,
          targetKey: targetKeyFor(pr, headSha),
          cwd: pr.worktreePath,
          addDirs: [contextDir],
          prompt: material.prompt,
          outputSchema: verificationReportSchema(material.limits),
          plugins: ["yarvis-review"],
          allowedTools: ALLOWED_TOOLS,
          disallowedTools: DISALLOWED_TOOLS,
          model: settings.model,
          maxBudgetUsd: settings.maxBudgetUsd,
          maxTurns: MAX_TURNS,
          timeoutMs: RUN_TIMEOUT_MS,
          meta: {
            workspaceId,
            prId,
            refKey: pr.refKey,
            headSha,
            summaryWords: material.limits.summaryWords,
            mustReadMax: material.limits.mustReadMax,
            detailLoaded: detail !== null,
          },
        },
        deps.run,
      );
      void handle.done.finally(removeContext);
      return { runId: handle.id, existing: false };
    } catch (e) {
      removeContext();
      throw e;
    }
  });
}

export interface LatestVerification {
  run: (AgentRunSummary & { live: boolean }) | null;
  /** The PR's head now. */
  headSha: string | null;
  /** True when the run was made against that head. */
  current: boolean;
}

/** The PR's most recent verification run, and whether the PR has moved on since. */
export async function latestVerification(
  db: Db,
  workspaceId: string,
  prId: string,
  isLive: (id: string) => boolean,
): Promise<LatestVerification> {
  const pr = await getReviewPr(db, workspaceId, prId);
  const id = await latestRunId(db, pr.refKey);
  const run = id ? await getAgentRunSummary(db, id) : null;
  return {
    run: run ? { ...run, live: isLive(run.id) } : null,
    headSha: pr.headSha,
    current: run !== null && pr.headSha !== null && run.targetKey === targetKeyFor(pr, pr.headSha),
  };
}
