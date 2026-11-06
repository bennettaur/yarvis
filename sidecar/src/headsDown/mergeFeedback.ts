import { and, eq, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  headsDownFeedbackHandoffs,
  type Repo,
  repos,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import { type PrCodeSource, prSourceFor } from "../pr/source.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import {
  agentTabPids,
  type ClaudeSessionMessenger,
  sendSessionInstruction,
  sendToWorkspaceAgent,
} from "../workspaces/claudeSession.ts";
import { getWorkspace, workspacePrRef } from "../workspaces/service.ts";
import { mergeKey } from "./attention.ts";

/**
 * Open review feedback on a PR heads-down mode is about to merge.
 *
 * A merge with feedback still open doesn't run on its own. Yarvis tells the
 * session of the workspace that owns the PR to address it, once per run. If
 * the feedback is still open on the next try, the send failed, or no workspace
 * owns the PR, the merge waits for the user, who sees the feedback in the
 * approval modal.
 */

/** At most this many threads travel with a merge review, and this much of each comment. */
const MAX_THREADS = 20;
const MAX_COMMENT_CHARS = 500;
const MAX_REASON_CHARS = 200;

const OWNER_REPO = /^[\w.-]+\/[\w.-]+$/;

export interface FeedbackThread {
  path: string | null;
  line: number | null;
  /** True when the code the thread was left on has since changed. */
  outdated: boolean;
  author: string;
  /** The thread's first comment, cut to `MAX_COMMENT_CHARS`. Third-party text. */
  body: string;
  /** How many replies follow the first comment. */
  replies: number;
}

export interface PrFeedback {
  /** "owner/repo". */
  repo: string;
  number: number;
  title: string | null;
  /** The active workspace whose branch this PR is, if any. */
  workspaceId: string | null;
  /** True once this run told that workspace's session to address the feedback. */
  handedOff: boolean;
  threads: FeedbackThread[];
  /** How many unresolved threads there are, including ones past `MAX_THREADS`. */
  threadCount: number;
  /** True when the provider couldn't return every thread, so there may be more. */
  threadsTruncated: boolean;
  /** Reviewers whose standing review asks for changes. */
  changesRequestedBy: string[];
}

export interface MergeFeedbackResult {
  /** The PRs the merge touches that have open feedback. Empty when `unchecked` is set. */
  prs: PrFeedback[];
  /** Why the feedback couldn't be checked, when it couldn't. Null when it was. */
  unchecked: string | null;
}

/**
 * Which PR a merge is for. `githubOnly` says a repo no workspace owns may be
 * looked up on GitHub, which is only safe when the merge tool is GitHub's.
 */
export type MergeSubject =
  | { workspaceId: string }
  | { repo: string; number: number; githubOnly: boolean };

/** Whether the merge has to wait: open feedback, or feedback nobody could check. */
export function holdsMerge(result: MergeFeedbackResult | null): result is MergeFeedbackResult {
  return result !== null && (result.prs.length > 0 || result.unchecked !== null);
}

type FoundFeedback = Pick<
  PrFeedback,
  "title" | "threads" | "threadCount" | "threadsTruncated" | "changesRequestedBy"
>;

/** The unresolved threads and blocking reviews in a PR's detail. */
export function feedbackIn(
  detail: Pick<PrDetail, "title" | "reviewThreads" | "reviewThreadsTruncated" | "reviewers">,
): FoundFeedback {
  const open = detail.reviewThreads.filter((t) => !t.isResolved);
  return {
    title: detail.title || null,
    threads: open.slice(0, MAX_THREADS).flatMap((t) => {
      const [first, ...rest] = t.comments;
      if (!first) return [];
      return [
        {
          path: t.path,
          line: t.line,
          outdated: t.isOutdated,
          author: first.author,
          body: first.body.slice(0, MAX_COMMENT_CHARS),
          replies: rest.length,
        },
      ];
    }),
    threadCount: open.length,
    threadsTruncated: Boolean(detail.reviewThreadsTruncated),
    changesRequestedBy: detail.reviewers
      .filter((r) => r.state === "changes_requested")
      .map((r) => r.login),
  };
}

/** Threads that couldn't be loaded count, since any of them may be open. */
function hasFeedback(f: FoundFeedback): boolean {
  return f.threadCount > 0 || f.threadsTruncated || f.changesRequestedBy.length > 0;
}

interface WorkspacePr {
  workspaceId: string;
  repo: Repo;
  prNumber: number;
}

/** Open PRs on active workspaces' branches, as the poller last saw them. */
async function workspacePrs(
  db: Db,
  where: { workspaceId: string } | { owner: string; name: string; number: number },
): Promise<WorkspacePr[]> {
  const conditions = [eq(workspaces.status, "active"), eq(workspaceRepoPr.prState, "open")];
  if ("workspaceId" in where) {
    conditions.push(eq(workspaces.id, where.workspaceId));
  } else {
    conditions.push(eq(workspaceRepoPr.prNumber, where.number));
    conditions.push(sql`lower(${repos.owner}) = ${where.owner.toLowerCase()}`);
    conditions.push(sql`lower(${repos.repo}) = ${where.name.toLowerCase()}`);
  }
  const rows = await db
    .select({ workspaceId: workspaces.id, repo: repos, prNumber: workspaceRepoPr.prNumber })
    .from(workspaceRepoPr)
    .innerJoin(workspaceRepos, eq(workspaceRepos.id, workspaceRepoPr.workspaceRepoId))
    .innerJoin(workspaces, eq(workspaces.id, workspaceRepos.workspaceId))
    .innerJoin(repos, eq(repos.id, workspaceRepos.repoId))
    .where(and(...conditions));
  return rows.flatMap((r) => (r.prNumber === null ? [] : [{ ...r, prNumber: r.prNumber }]));
}

interface Target {
  repo: string;
  number: number;
  ref: PrRef;
  workspaceId: string | null;
}

function ownedTarget(p: WorkspacePr): Target | null {
  const ref = workspacePrRef(p.repo, p.prNumber);
  if (!ref) return null;
  return {
    repo: `${p.repo.owner}/${p.repo.repo}`,
    number: p.prNumber,
    ref,
    workspaceId: p.workspaceId,
  };
}

/** The PRs a merge is for, each with its provider ref and owning workspace. */
async function mergeTargets(
  db: Db,
  subject: MergeSubject,
): Promise<{ targets: Target[] } | { unchecked: string }> {
  if ("workspaceId" in subject) {
    const prs = await workspacePrs(db, subject);
    if (prs.length === 0) return { unchecked: "the workspace has no open PR Yarvis has seen yet" };
    const targets = prs.map(ownedTarget);
    if (targets.some((t) => t === null)) {
      return { unchecked: "can't tell which provider hosts the workspace's repo" };
    }
    return { targets: targets.filter((t) => t !== null) };
  }
  // A PR number alone could match a different repo's PR, so a call without a
  // well-formed repo is never checked against one.
  if (!OWNER_REPO.test(subject.repo))
    return { unchecked: "the merge call doesn't name the PR's repo" };
  const [owner = "", name = ""] = subject.repo.split("/");
  const [owned] = await workspacePrs(db, { owner, name, number: subject.number });
  const target = owned ? ownedTarget(owned) : null;
  if (target) return { targets: [target] };
  if (!subject.githubOnly) {
    return { unchecked: "no workspace has this PR, and the merge tool may not be GitHub's" };
  }
  return {
    targets: [
      {
        repo: subject.repo,
        number: subject.number,
        ref: { provider: "github", owner, repo: name, number: subject.number },
        workspaceId: null,
      },
    ],
  };
}

export type MergeFeedbackLoader = (subject: MergeSubject) => Promise<MergeFeedbackResult>;

/**
 * Reads the open feedback on every PR a merge is for, live from the provider.
 * Any failure leaves the merge unchecked, which holds it for the user.
 */
export function mergeFeedbackLoader(
  db: Db,
  config: Pick<Config, "secrets" | "endpoints">,
  sourceFor: (ref: PrRef) => PrCodeSource | { error: string } = (ref) => prSourceFor(config, ref),
): MergeFeedbackLoader {
  return async (subject) => {
    try {
      const found = await mergeTargets(db, subject);
      if ("unchecked" in found) return { prs: [], unchecked: found.unchecked };
      const prs: PrFeedback[] = [];
      for (const target of found.targets) {
        const source = sourceFor(target.ref);
        if ("error" in source) return { prs: [], unchecked: source.error };
        const feedback = feedbackIn(await source.detail());
        if (hasFeedback(feedback)) {
          const { ref: _ref, ...pr } = target;
          prs.push({ ...pr, handedOff: false, ...feedback });
        }
      }
      return { prs, unchecked: null };
    } catch (e) {
      const reason = e instanceof Error ? e.message : String(e);
      return { prs: [], unchecked: `reading the PR failed: ${reason.slice(0, MAX_REASON_CHARS)}` };
    }
  };
}

/**
 * What Yarvis types into the workspace's session. Fixed text, so nothing a
 * reviewer wrote reaches the session as an instruction: it reads the threads
 * itself, as review comments.
 */
export function feedbackInstruction(pr: Pick<PrFeedback, "repo" | "number">): string {
  return `There is open review feedback on PR ${pr.repo}#${pr.number}. Read its unresolved review threads and any review asking for changes, and address them: change what you agree with and push, and reply on each thread you won't change saying why. Resolve the threads you've handled. Leave the PR open.`;
}

/** Whether this run already handed the PR's feedback to its workspace. */
async function wasHandedOff(db: Db, runId: string, pr: PrFeedback): Promise<boolean> {
  const rows = await db
    .select({ id: headsDownFeedbackHandoffs.id })
    .from(headsDownFeedbackHandoffs)
    .where(
      and(
        eq(headsDownFeedbackHandoffs.runId, runId),
        eq(headsDownFeedbackHandoffs.prKey, mergeKey(pr.repo, pr.number)),
      ),
    )
    .limit(1);
  return rows.length > 0;
}

/**
 * Tells each held PR's workspace session to address its feedback, once per
 * run, and marks each PR with whether that has happened. Returns the PRs
 * handed off by this call. A workspace `maySteer` refuses, or a send that
 * fails, isn't recorded, so that PR goes to the user instead.
 */
export async function handOffFeedback(
  db: Db,
  runId: string,
  feedback: MergeFeedbackResult,
  {
    maySteer,
    send = sendSessionInstruction,
  }: {
    /** Whether heads-down mode may type into this workspace's session without asking. */
    maySteer: (workspaceId: string) => Promise<boolean>;
    send?: ClaudeSessionMessenger;
  },
): Promise<PrFeedback[]> {
  const handed: PrFeedback[] = [];
  for (const pr of feedback.prs) {
    if (!pr.workspaceId) continue;
    if (await wasHandedOff(db, runId, pr)) {
      pr.handedOff = true;
      continue;
    }
    if (!(await maySteer(pr.workspaceId))) continue;
    const workspace = await getWorkspace(db, pr.workspaceId);
    if (workspace?.status !== "active") continue;
    const sent = await sendToWorkspaceAgent(db, workspace, feedbackInstruction(pr), {
      agentPids: await agentTabPids(db, workspace.id),
      send,
      eventSource: "heads-down",
    });
    if (!sent.delivered) {
      console.error(`[heads-down] handing off feedback on ${pr.repo}#${pr.number}:`, sent.error);
      continue;
    }
    await db
      .insert(headsDownFeedbackHandoffs)
      .values({ runId, prKey: mergeKey(pr.repo, pr.number), workspaceId: workspace.id })
      .onConflictDoNothing();
    pr.handedOff = true;
    handed.push(pr);
  }
  return handed;
}

/** Counts only, never comments or names, since the pass reads this and they are third-party text. */
export function feedbackSummary(pr: PrFeedback): string {
  const threads = `${pr.threadCount}${pr.threadsTruncated ? "+" : ""} unresolved review thread${pr.threadCount === 1 ? "" : "s"}`;
  const reviews = `${pr.changesRequestedBy.length} review${pr.changesRequestedBy.length === 1 ? "" : "s"} asking for changes`;
  const parts = [
    (pr.threadCount > 0 || pr.threadsTruncated) && threads,
    pr.changesRequestedBy.length > 0 && reviews,
  ].filter(Boolean);
  return `${pr.repo}#${pr.number}: ${parts.join("; ")}`;
}
