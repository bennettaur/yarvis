import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AttentionNavTarget } from "../db/schema.ts";
import { countEventsByType, REVIEW_EVENT_TYPES } from "../events/service.ts";
import { GitHubClient } from "../github/client.ts";
import { getGithubPrConfig } from "../github/config.ts";
import { getReviewingList, isReviewComplete } from "../github/reviewing.ts";
import { type PrInvolvement, type PrSummary, refKey } from "../pr/types.ts";
import { listTasks } from "../tasks/service.ts";
import { listTodos } from "../todos/service.ts";
import { listWorkspaces } from "../workspaces/service.ts";
import { dismissedKeys } from "./dismissals.ts";

/**
 * Finding the work that fell off the user's radar, and deciding what to point
 * them at next.
 *
 * This owns no table: it reads the PR provider, the workspace and task services,
 * the agent's own todos, and the event log, then ranks. Everything it returns
 * carries a `key` — the same key a dismissal is recorded against — so "not that
 * one" is a durable answer rather than something the next call forgets.
 */

/** Where a dangling item came from, which is also its ranking bucket. */
export type DanglingKind =
  | "my-pr"
  | "review-requested"
  | "review-in-progress"
  | "workspace"
  | "task"
  | "todo";

export interface DanglingItem {
  /** Stable identity, used for dismissals and for de-duplication. */
  key: string;
  kind: DanglingKind;
  title: string;
  /** Why this is outstanding, in words the agent can relay. */
  reason: string;
  url?: string;
  navTarget?: AttentionNavTarget;
  /** Last time anything happened to it, for staleness ordering. */
  updatedAt?: string;
}

export interface DanglingWork {
  items: DanglingItem[];
  /** Sources that couldn't be read (e.g. no GitHub token), so the agent can say so. */
  unavailable: string[];
}

/**
 * The key a dismissal is matched on, from `pr/types.ts` — the one definition, not
 * a copy: a second implementation that drifted would silently stop "not that
 * one" from sticking.
 */
function prKey(pr: Pick<PrSummary, "owner" | "repo" | "number">): string {
  return refKey({ provider: "github", ...pr });
}

function prNav(pr: Pick<PrSummary, "owner" | "repo" | "number">): AttentionNavTarget {
  return { type: "pr", owner: pr.owner, repo: pr.repo, number: pr.number };
}

function danglingFromInvolvement(item: PrInvolvement, reason: string): DanglingItem {
  return {
    key: prKey(item.summary),
    kind: "review-in-progress",
    title: `${item.summary.owner}/${item.summary.repo}#${item.summary.number} ${item.summary.title}`,
    reason,
    url: item.summary.url,
    navTarget: prNav(item.summary),
    updatedAt: item.summary.updatedAt,
  };
}

export interface FindDanglingOptions {
  /** How far back to look for review involvement. Defaults to the PR config. */
  lookbackDays?: number;
  /** Include items the user has dismissed. Off by default. */
  includeDismissed?: boolean;
}

/**
 * Everything in flight that nobody is currently looking at: the user's own open
 * PRs, reviews requested of them, reviews they started and never finished, active
 * workspaces, overdue tasks, and the assistant's own open todos.
 *
 * A missing GitHub token degrades to the local sources rather than failing —
 * "what have I left hanging" is still worth answering offline.
 */
export async function findDanglingWork(
  db: Db,
  config: Config,
  options: FindDanglingOptions = {},
): Promise<DanglingWork> {
  const items: DanglingItem[] = [];
  const unavailable: string[] = [];
  const today = new Date().toISOString().slice(0, 10);

  // Started before the provider work below, not after it: these four reads are
  // independent of GitHub and of each other, so they cost nothing once the
  // network latency is already being paid.
  const localReads = Promise.all([
    listWorkspaces(db),
    listTasks(db, { status: "open" }),
    listTodos(db),
    options.includeDismissed ? Promise.resolve(new Set<string>()) : dismissedKeys(db),
  ]);

  const token = config.secrets?.githubToken;
  if (!token) {
    unavailable.push("github (no token configured)");
  } else {
    const gh = new GitHubClient(token);
    const prConfig = await getGithubPrConfig();
    const lookbackDays = options.lookbackDays ?? prConfig.reviewingLookbackDays;
    try {
      // Only the reviewing list needs the viewer's login, so the two searches
      // don't wait on that round-trip.
      const viewerPromise = gh.viewer();
      const [mine, requested, reviewing, viewer] = await Promise.all([
        gh.search("is:pr is:open author:@me"),
        gh.search(prConfig.reviewQuery),
        viewerPromise.then((v) => getReviewingList(db, gh, v.login, lookbackDays)),
        viewerPromise,
      ]);

      // Ordered strongest claim first, because the dedupe below keeps the first
      // entry for a key: a PR someone is waiting on the user to review matters
      // more than the same PR also being one of theirs.
      for (const pr of requested) {
        items.push({
          key: prKey(pr),
          kind: "review-requested",
          title: `${pr.owner}/${pr.repo}#${pr.number} ${pr.title}`,
          reason: `review requested from you, opened by ${pr.author}`,
          url: pr.url,
          navTarget: prNav(pr),
          updatedAt: pr.updatedAt,
        });
      }

      // The in-progress half of the reviewing list is exactly "started and not
      // finished": viewed or commented on, with no verdict submitted yet. It is
      // partly fed by the local `pr.viewed` log, which does not exclude the
      // user's own pull requests — and opening your own PR is not a review you
      // owe anyone, so those are dropped rather than reported as unfinished
      // review work.
      for (const item of reviewing.inProgress) {
        if (isReviewComplete(item)) continue;
        if (item.summary.author === viewer.login) continue;
        items.push(
          danglingFromInvolvement(
            item,
            "you looked at or commented on this but never signed it off",
          ),
        );
      }

      for (const pr of mine) {
        items.push({
          key: prKey(pr),
          kind: "my-pr",
          title: `${pr.owner}/${pr.repo}#${pr.number} ${pr.title}`,
          reason: pr.draft
            ? "your own PR, still a draft"
            : "your own PR, open and waiting on review or merge",
          url: pr.url,
          navTarget: prNav(pr),
          updatedAt: pr.updatedAt,
        });
      }
    } catch (e) {
      unavailable.push(`github (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  const [workspaces, openTasks, todos, dismissed] = await localReads;

  for (const workspace of workspaces) {
    if (workspace.status !== "active") continue;
    const pr = workspace.prs[0];
    items.push({
      key: `workspace:${workspace.id}`,
      kind: "workspace",
      title: workspace.name,
      reason: pr
        ? `workspace still open; ${pr.repoName} PR #${pr.prNumber} is ${pr.prState ?? "open"}${
            pr.checkRollup === "failure" ? " with failing checks" : ""
          }`
        : "workspace still open with no PR yet",
      navTarget: { type: "workspace", workspaceId: workspace.id },
      updatedAt: workspace.updatedAt.toISOString(),
    });
  }

  for (const task of openTasks) {
    // Only tasks that have slipped: today's list is not dangling work, it's the
    // plan. A task with no date can't be judged, so it is left out.
    if (!task.targetDate || task.targetDate >= today) continue;
    items.push({
      key: `task:${task.id}`,
      kind: "task",
      title: task.title,
      reason: `${task.scope} task that was due ${task.targetDate} and is still open`,
      navTarget: { type: "task", taskId: task.id },
      updatedAt: task.createdAt.toISOString(),
    });
  }

  for (const todo of todos) {
    items.push({
      key: `todo:${todo.id}`,
      kind: "todo",
      title: todo.title,
      reason:
        todo.status === "blocked"
          ? "your own todo, blocked"
          : `your own todo (${todo.status}, ${todo.priority})`,
      updatedAt: todo.updatedAt.toISOString(),
    });
  }

  const deduped = new Map<string, DanglingItem>();
  for (const item of items) {
    if (!deduped.has(item.key)) deduped.set(item.key, item);
  }

  const result = [...deduped.values()].filter((item) => !dismissed.has(item.key));
  return { items: result, unavailable };
}

/** Ranking weight per source: finishing beats starting, and a review someone
 *  is waiting on beats the user's own PR sitting in a queue. */
const KIND_WEIGHT: Record<DanglingKind, number> = {
  "review-in-progress": 5,
  "review-requested": 4,
  workspace: 3,
  "my-pr": 2,
  todo: 1,
  task: 1,
};

/**
 * Review events in a week below which the planner starts promoting reviews. A
 * count, not a cadence: what is compared against it is the number of review
 * touches in the last seven days.
 */
const MIN_WEEKLY_REVIEW_EVENTS = 3;

export interface ReviewCadence {
  /** Review-flavoured events in the last week. */
  lastWeek: number;
  /** True when the week is thin enough that a review should be suggested. */
  lowActivity: boolean;
}

/** How much reviewing the user has done lately, which shapes the suggestions. */
export async function reviewCadence(db: Db, now: Date = new Date()): Promise<ReviewCadence> {
  const since = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const counts = await countEventsByType(db, { since, types: REVIEW_EVENT_TYPES });
  const lastWeek = counts.reduce((sum, c) => sum + c.count, 0);
  return { lastWeek, lowActivity: lastWeek < MIN_WEEKLY_REVIEW_EVENTS };
}

export interface Suggestion extends DanglingItem {
  /** Why this is being suggested now, on top of why it is outstanding. */
  rationale: string;
  score: number;
}

export interface NextWork {
  suggestions: Suggestion[];
  cadence: ReviewCadence;
  unavailable: string[];
}

/**
 * Ranks the dangling work into a short list to offer. Ordering is deterministic
 * — kind weight, then staleness — so the agent's three suggestions don't shuffle
 * between turns for no reason, and a low-review week promotes one review to the
 * top so the nudge is structural rather than something the prompt has to
 * remember to do.
 */
export async function suggestNextWork(
  db: Db,
  config: Config,
  options: { limit?: number; now?: Date } = {},
): Promise<NextWork> {
  const now = options.now ?? new Date();
  const [{ items, unavailable }, cadence] = await Promise.all([
    findDanglingWork(db, config),
    reviewCadence(db, now),
  ]);

  const staleness = (item: DanglingItem): number => {
    if (!item.updatedAt) return 0;
    const age = now.getTime() - new Date(item.updatedAt).getTime();
    return Number.isFinite(age) ? age / (24 * 60 * 60 * 1000) : 0;
  };

  const scored: Suggestion[] = items.map((item) => {
    const reviewBoost =
      cadence.lowActivity &&
      (item.kind === "review-requested" || item.kind === "review-in-progress")
        ? 3
        : 0;
    // Staleness is capped so a month-old draft can't outrank a review someone is
    // actively waiting on.
    const score = KIND_WEIGHT[item.kind] + reviewBoost + Math.min(staleness(item), 14) / 7;
    return {
      ...item,
      score: Number(score.toFixed(2)),
      rationale:
        reviewBoost > 0
          ? "raised because you have done little reviewing this week"
          : item.kind === "review-in-progress" || item.kind === "workspace"
            ? "already started — finishing it costs less than starting something new"
            : "outstanding and waiting on you",
    };
  });

  scored.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
  return { suggestions: scored.slice(0, options.limit ?? 3), cadence, unavailable };
}
