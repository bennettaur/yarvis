import { and, eq, sql } from "drizzle-orm";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import {
  headsDownFeedbackHandoffs,
  repos,
  workspaceRepoPr,
  workspaceRepos,
  workspaces,
} from "../db/schema.ts";
import { type PrCodeSource, prSourceFor } from "../pr/source.ts";
import type { PrDetail, PrRef } from "../pr/types.ts";
import { workspacePrRef } from "../workspaces/tools.ts";
import { mergeKey } from "./attention.ts";
import { mergeCallTarget } from "./policy.ts";

/**
 * Open review feedback on a PR heads-down mode is about to merge.
 *
 * A merge with feedback still open doesn't run on its own. The workspace that
 * owns the PR is asked to address it first, once per run. If the feedback is
 * still open on the next try, or no workspace owns the PR, the merge waits for
 * the user, who sees the feedback in the approval modal.
 */

/** At most this many threads travel with a merge review, and this much of each comment. */
const MAX_THREADS = 20;
const MAX_COMMENT_CHARS = 500;

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
  url?: string;
}

export interface PrFeedback {
  /** "owner/repo". */
  repo: string;
  number: number;
  title: string | null;
  /** The active workspace whose branch this PR is, if any. */
  workspaceId: string | null;
  threads: FeedbackThread[];
  /** How many unresolved threads there are, including ones past `MAX_THREADS`. */
  threadCount: number;
  /** True when the provider couldn't return every thread, so there may be more. */
  threadsTruncated: boolean;
  /** Reviewers whose standing review asks for changes. */
  changesRequestedBy: string[];
}

export interface MergeFeedbackResult {
  /** The PRs the merge touches that have open feedback. */
  prs: PrFeedback[];
  /** Why the feedback couldn't be checked, when it couldn't. Null when it was. */
  unchecked: string | null;
}

/** Whether the merge has to wait: open feedback, or feedback nobody could check. */
export function holdsMerge(result: MergeFeedbackResult | null): result is MergeFeedbackResult {
  return result !== null && (result.prs.length > 0 || result.unchecked !== null);
}

/** The unresolved threads and blocking reviews in a PR's detail. Empty lists mean none. */
export function feedbackIn(
  detail: Pick<PrDetail, "title" | "reviewThreads" | "reviewThreadsTruncated" | "reviewers">,
): Pick<
  PrFeedback,
  "title" | "threads" | "threadCount" | "threadsTruncated" | "changesRequestedBy"
> {
  const open = detail.reviewThreads.filter((t) => !t.isResolved && t.comments.length > 0);
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
          ...(first.url ? { url: first.url } : {}),
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

function hasFeedback(f: Pick<PrFeedback, "threadCount" | "changesRequestedBy">): boolean {
  return f.threadCount > 0 || f.changesRequestedBy.length > 0;
}

interface WorkspacePr {
  workspaceId: string;
  repo: typeof repos.$inferSelect;
  prNumber: number;
}

/** Open PRs on active workspaces' branches, as the poller last saw them. */
async function workspacePrs(
  db: Db,
  where: { workspaceId: string } | { repo: string; number: number },
): Promise<WorkspacePr[]> {
  const conditions = [eq(workspaces.status, "active"), eq(workspaceRepoPr.prState, "open")];
  if ("workspaceId" in where) {
    conditions.push(eq(workspaces.id, where.workspaceId));
  } else {
    conditions.push(eq(workspaceRepoPr.prNumber, where.number));
    const [owner, name] = where.repo.toLowerCase().split("/");
    if (owner && name) {
      conditions.push(sql`lower(${repos.owner}) = ${owner}`);
      conditions.push(sql`lower(${repos.repo}) = ${name}`);
    }
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

/**
 * The PRs a merge call merges, each with its provider ref and owning
 * workspace. A string is why they can't be told.
 */
async function mergeTargets(db: Db, tool: string, args: unknown): Promise<Target[] | string> {
  if (tool === "send_workspace_instruction") {
    const workspaceId = (args as { workspaceId?: unknown } | null)?.workspaceId;
    if (typeof workspaceId !== "string") return "the instruction names no workspace";
    const prs = await workspacePrs(db, { workspaceId });
    if (prs.length === 0) return "the workspace has no open PR that Yarvis has seen yet";
    const targets: Target[] = [];
    for (const p of prs) {
      const ref = workspacePrRef(p.repo, p.prNumber);
      if (!ref) return "can't tell which provider hosts the workspace's repo";
      targets.push({
        repo: `${p.repo.owner}/${p.repo.repo}`,
        number: p.prNumber,
        ref,
        workspaceId,
      });
    }
    return targets;
  }
  const target = mergeCallTarget(tool, args);
  if (!target) return "the merge call doesn't say which PR it merges";
  const owned = await workspacePrs(db, target);
  // Without a repo the number alone only identifies a PR if one workspace has it.
  if (!target.repo && owned.length !== 1) return "the merge call doesn't name the PR's repo";
  const mine = owned[0];
  const ref = mine && workspacePrRef(mine.repo, mine.prNumber);
  if (mine && ref) {
    return [
      {
        repo: target.repo || `${mine.repo.owner}/${mine.repo.repo}`,
        number: target.number,
        ref,
        workspaceId: mine.workspaceId,
      },
    ];
  }
  const [owner, name] = target.repo.split("/");
  if (!owner || !name) return "the merge call doesn't name the PR's repo";
  return [
    {
      repo: target.repo,
      number: target.number,
      ref: { provider: "github", owner, repo: name, number: target.number },
      workspaceId: null,
    },
  ];
}

export type MergeFeedbackLoader = (tool: string, args: unknown) => Promise<MergeFeedbackResult>;

/**
 * Reads the open feedback on every PR a merge call merges, live from the
 * provider. Any failure leaves the merge unchecked, which holds it for the user.
 */
export function mergeFeedbackLoader(
  db: Db,
  config: Pick<Config, "secrets" | "endpoints">,
  sourceFor: (ref: PrRef) => PrCodeSource | { error: string } = (ref) => prSourceFor(config, ref),
): MergeFeedbackLoader {
  return async (tool, args) => {
    try {
      const targets = await mergeTargets(db, tool, args);
      if (typeof targets === "string") return { prs: [], unchecked: targets };
      const prs: PrFeedback[] = [];
      for (const target of targets) {
        const source = sourceFor(target.ref);
        if ("error" in source) return { prs, unchecked: source.error };
        const found = feedbackIn(await source.detail());
        if (hasFeedback(found)) {
          prs.push({
            repo: target.repo,
            number: target.number,
            workspaceId: target.workspaceId,
            ...found,
          });
        }
      }
      return { prs, unchecked: null };
    } catch (e) {
      return {
        prs: [],
        unchecked: `reading the PR failed: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  };
}

/**
 * Records that this run handed a PR's feedback to its workspace. Returns false
 * when it already had, so the next attempt goes to the user instead.
 */
export async function recordHandoff(
  db: Db,
  runId: string,
  pr: Pick<PrFeedback, "repo" | "number" | "workspaceId">,
): Promise<boolean> {
  const rows = await db
    .insert(headsDownFeedbackHandoffs)
    .values({ runId, prKey: mergeKey(pr.repo, pr.number), workspaceId: pr.workspaceId })
    .onConflictDoNothing()
    .returning({ id: headsDownFeedbackHandoffs.id });
  return rows.length > 0;
}

/**
 * What a pass sends the workspace's session. Fixed text, so nothing a reviewer
 * wrote is typed into the session as an instruction: the session reads the
 * threads itself, as review comments.
 */
export function feedbackInstruction(pr: Pick<PrFeedback, "repo" | "number">): string {
  return `There is open review feedback on PR ${pr.repo}#${pr.number}. Read its unresolved review threads and any review asking for changes, and address them: change what you agree with and push, and reply on each thread you won't change saying why. Resolve the threads you've handled. Don't merge the PR.`;
}

/** Counts only, never comments or names, since the pass reads this and they are third-party text. */
export function feedbackSummary(pr: PrFeedback): string {
  const parts = [
    pr.threadCount > 0 &&
      `${pr.threadCount}${pr.threadsTruncated ? "+" : ""} unresolved review thread${pr.threadCount === 1 ? "" : "s"}`,
    pr.changesRequestedBy.length > 0 &&
      `${pr.changesRequestedBy.length} review${pr.changesRequestedBy.length === 1 ? "" : "s"} asking for changes`,
  ].filter(Boolean);
  return `${pr.repo}#${pr.number}: ${parts.join("; ")}`;
}
