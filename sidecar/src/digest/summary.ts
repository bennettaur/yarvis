import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { countEventsByType, type EventType, listEvents } from "../events/service.ts";
import { GitHubClient } from "../github/client.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { PgVectorMemoryStore } from "../memory/index.ts";
import { refKey } from "../pr/types.ts";
import { tasksCompletedBetween } from "../tasks/service.ts";

/**
 * The material behind "what did I get done this week".
 *
 * Deliberately data, not prose: this assembles what happened from the event log,
 * the provider, the task table and the day summaries, and the model writes the
 * paragraph. Keeping the gathering separate is what lets the same material back
 * a weekly recap in chat, a Telegram message, and a job-written memory without
 * three slightly different definitions of "this week".
 */

/** Verdict events, which are the interesting half of review activity. */
const REVIEW_VERDICT_EVENTS: readonly EventType[] = [
  "pr.approved",
  "pr.changes_requested",
  "pr.review_commented",
  "pr.commented",
];

export interface SummaryWindow {
  from: Date;
  to: Date;
}

/**
 * The window covering the current (or a past) week, Monday to now. `weeksAgo: 1`
 * is last week, ending Sunday night rather than at the same clock time.
 */
export function weekWindow(now: Date = new Date(), weeksAgo = 0): SummaryWindow {
  const from = new Date(now);
  from.setHours(0, 0, 0, 0);
  const daysSinceMonday = (from.getDay() + 6) % 7;
  from.setDate(from.getDate() - daysSinceMonday - weeksAgo * 7);
  if (weeksAgo === 0) return { from, to: now };
  const to = new Date(from);
  to.setDate(to.getDate() + 7);
  return { from, to };
}

export interface PrOutcome {
  key: string;
  title: string;
  url: string;
  state: string;
  draft: boolean;
  updatedAt: string;
}

export interface WeeklySummaryMaterial {
  window: { from: string; to: string };
  /** Every event type that fired in the window, with counts. */
  activity: { type: string; count: number }[];
  /** Review verdicts the user gave, by pull request. */
  reviewsGiven: { type: string; ref: string; at: string }[];
  /** The user's own pull requests touched in the window, with current state. */
  myPullRequests: PrOutcome[];
  tasksCompleted: { title: string; scope: string; completedAt: string | null }[];
  workspacesArchived: { name: string; summary: string | null; at: string }[];
  /** Day summaries the consolidation job already wrote for this window. */
  daySummaries: { at: string; content: string }[];
  /** Sources that couldn't be read, so the summary can admit the gap. */
  unavailable: string[];
}

/**
 * A PR event's payload carries its ref as a `refKey` string; `pr.viewed` rows,
 * which the frontend writes, carry the structured ref instead. Both are turned
 * into a key by `refKey` rather than by formatting one here, so this can't drift
 * from the keys dismissals are matched on.
 */
function refFromPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const ref = (payload as { ref?: unknown }).ref;
  if (typeof ref === "string") return ref;
  if (!ref || typeof ref !== "object") return null;
  const parts = ref as Record<string, unknown>;
  if (
    parts.provider === "github" &&
    typeof parts.owner === "string" &&
    typeof parts.repo === "string" &&
    typeof parts.number === "number"
  ) {
    return refKey({
      provider: "github",
      owner: parts.owner,
      repo: parts.repo,
      number: parts.number,
    });
  }
  if (
    parts.provider === "azure" &&
    typeof parts.org === "string" &&
    typeof parts.project === "string" &&
    typeof parts.repo === "string" &&
    typeof parts.prId === "number"
  ) {
    return refKey({
      provider: "azure",
      org: parts.org,
      project: parts.project,
      repo: parts.repo,
      prId: parts.prId,
    });
  }
  return null;
}

function payloadString(payload: unknown, key: string): string | null {
  if (!payload || typeof payload !== "object") return null;
  const value = (payload as Record<string, unknown>)[key];
  return typeof value === "string" ? value : null;
}

/** Gathers everything a weekly (or arbitrary-window) summary is written from. */
export async function weeklySummaryMaterial(
  db: Db,
  config: Config,
  window: SummaryWindow,
): Promise<WeeklySummaryMaterial> {
  const unavailable: string[] = [];

  const [activity, verdicts, archived, tasks, daySummaries] = await Promise.all([
    countEventsByType(db, { since: window.from, until: window.to }),
    listEvents(db, {
      types: REVIEW_VERDICT_EVENTS,
      since: window.from,
      until: window.to,
      limit: 200,
      oldestFirst: true,
    }),
    listEvents(db, {
      type: "workspace.archived",
      since: window.from,
      until: window.to,
      limit: 100,
      oldestFirst: true,
    }),
    tasksCompletedBetween(db, window.from, window.to),
    (async () => {
      const memory = new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
      // Bounded at both ends in the query: filtering the upper bound afterwards
      // would return the newest 30 day summaries and then discard them all for
      // any week but the current one.
      return memory.list({
        kinds: ["day-summary"],
        since: window.from,
        until: window.to,
        limit: 30,
      });
    })(),
  ]);

  let myPullRequests: PrOutcome[] = [];
  const token = config.secrets?.githubToken;
  if (!token) {
    unavailable.push("github (no token configured)");
  } else {
    try {
      const since = window.from.toISOString().slice(0, 10);
      // Both open and closed: a week's story includes what merged, and search
      // has no "state:any" so the absence of an `is:` qualifier is the way.
      const prs = await new GitHubClient(token).search(`is:pr author:@me updated:>=${since}`);
      myPullRequests = prs.map((pr) => ({
        key: `gh:${pr.owner}/${pr.repo}/${pr.number}`,
        title: `${pr.owner}/${pr.repo}#${pr.number} ${pr.title}`,
        url: pr.url,
        state: pr.state,
        draft: pr.draft,
        updatedAt: pr.updatedAt,
      }));
    } catch (e) {
      unavailable.push(`github (${e instanceof Error ? e.message : String(e)})`);
    }
  }

  return {
    window: { from: window.from.toISOString(), to: window.to.toISOString() },
    activity: activity.map((a) => ({ type: a.type, count: a.count })),
    reviewsGiven: verdicts
      .map((event) => ({
        type: event.type,
        ref: refFromPayload(event.payload) ?? "unknown",
        at: event.occurredAt.toISOString(),
      }))
      .filter((row) => row.ref !== "unknown"),
    myPullRequests,
    tasksCompleted: tasks.map((t) => ({
      title: t.title,
      scope: t.scope,
      completedAt: t.completedAt?.toISOString() ?? null,
    })),
    workspacesArchived: archived.map((event) => ({
      name: payloadString(event.payload, "name") ?? "a workspace",
      summary: payloadString(event.payload, "summary"),
      at: event.occurredAt.toISOString(),
    })),
    daySummaries: daySummaries.map((m) => ({
      at: m.createdAt.toISOString(),
      content: m.content,
    })),
    unavailable,
  };
}
