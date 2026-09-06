import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import type { AttentionNavTarget, GithubStar, IssueLink, IssueStar, Task } from "../db/schema.ts";
import { GitHubClient } from "../github/client.ts";
import { listStars as listPrStars } from "../github/service.ts";
import { listIssueRepos, listStars as listIssueStars, listLinks } from "../issues/service.ts";
import type { IssueSummary } from "../issues/types.ts";
import type { PrSummary } from "../pr/types.ts";
import { listTasks } from "../tasks/service.ts";
import type { WorkspaceSummary } from "../workspaces/service.ts";
import { listWorkspaces } from "../workspaces/service.ts";
import { getWipConfig } from "./config.ts";

/**
 * The work-in-progress stream: a read-only, prioritized roll-up of everything
 * the user has in flight, aggregated from the existing PR / issue / task /
 * workspace services. Purely derived — it creates nothing and owns no table.
 */

export type WipSource = "starred-pr" | "pr" | "issue" | "task" | "workspace";

export interface WipItem {
  id: string;
  source: WipSource;
  title: string;
  subtitle: string | null;
  navTarget: AttentionNavTarget | null;
}

/** The raw per-source inputs, passed to the pure prioritizer below. */
export interface WipInputs {
  starredPrs: GithubStar[];
  myPrs: PrSummary[];
  inProgressIssues: IssueLink[];
  /** Open issues assigned to the user carrying a configured label. */
  labeledIssues: IssueSummary[];
  starredIssues: IssueStar[];
  todayTasks: Task[];
  activeWorkspaces: WorkspaceSummary[];
}

const prKey = (owner: string, repo: string, number: number) => `${owner}/${repo}#${number}`;
const issueKey = (provider: string, sourceKey: string, externalId: string) =>
  `${provider}:${sourceKey}:${externalId}`;

/**
 * Orders the sources into one flat list. Priority (highest first): starred PRs,
 * my open PRs, in-progress issues, labeled issues, starred issues, today's open
 * tasks, active workspaces — recency preserved within each bucket by the callers'
 * ordering. Deduplicates a PR that is both mine and starred, and an issue that
 * appears in more than one issue source. Pure, so ordering is unit-testable.
 */
export function buildWipItems(inputs: WipInputs): WipItem[] {
  const items: WipItem[] = [];

  const starredPrKeys = new Set(inputs.starredPrs.map((s) => prKey(s.owner, s.repo, s.number)));
  for (const s of inputs.starredPrs) {
    items.push({
      id: `starred-pr:${prKey(s.owner, s.repo, s.number)}`,
      source: "starred-pr",
      title: s.title ?? prKey(s.owner, s.repo, s.number),
      subtitle: `${s.owner}/${s.repo}`,
      navTarget: { type: "pr", owner: s.owner, repo: s.repo, number: s.number },
    });
  }

  for (const pr of inputs.myPrs) {
    if (starredPrKeys.has(prKey(pr.owner, pr.repo, pr.number))) continue;
    items.push({
      id: `pr:${prKey(pr.owner, pr.repo, pr.number)}`,
      source: "pr",
      title: pr.title,
      subtitle: `${pr.owner}/${pr.repo} #${pr.number}`,
      navTarget: { type: "pr", owner: pr.owner, repo: pr.repo, number: pr.number },
    });
  }

  // Track issue keys already listed, so a single issue that is in-progress AND
  // labeled AND starred appears once (in that priority order).
  const seenIssues = new Set<string>();
  for (const link of inputs.inProgressIssues) {
    seenIssues.add(issueKey(link.provider, link.sourceKey, link.externalId));
    items.push({
      id: `issue:${issueKey(link.provider, link.sourceKey, link.externalId)}`,
      source: "issue",
      title: link.title ?? `${link.sourceKey}#${link.externalId}`,
      subtitle: link.sourceKey,
      navTarget: {
        type: "issue",
        provider: link.provider,
        sourceKey: link.sourceKey,
        externalId: link.externalId,
      },
    });
  }

  for (const issue of inputs.labeledIssues) {
    const key = issueKey(issue.provider, issue.sourceKey, issue.externalId);
    if (seenIssues.has(key)) continue;
    seenIssues.add(key);
    items.push({
      id: `labeled-issue:${key}`,
      source: "issue",
      title: issue.title,
      subtitle: issue.sourceKey,
      navTarget: {
        type: "issue",
        provider: issue.provider,
        sourceKey: issue.sourceKey,
        externalId: issue.externalId,
      },
    });
  }

  for (const s of inputs.starredIssues) {
    const key = issueKey(s.provider, s.sourceKey, s.externalId);
    if (seenIssues.has(key)) continue;
    seenIssues.add(key);
    items.push({
      id: `starred-issue:${key}`,
      source: "issue",
      title: s.title ?? `${s.sourceKey}#${s.externalId}`,
      subtitle: s.sourceKey,
      navTarget: {
        type: "issue",
        provider: s.provider,
        sourceKey: s.sourceKey,
        externalId: s.externalId,
      },
    });
  }

  for (const t of inputs.todayTasks) {
    if (t.status !== "open") continue;
    items.push({
      id: `task:${t.id}`,
      source: "task",
      title: t.title,
      subtitle: t.scope,
      navTarget: { type: "task", taskId: t.id },
    });
  }

  for (const ws of inputs.activeWorkspaces) {
    items.push({
      id: `workspace:${ws.id}`,
      source: "workspace",
      title: ws.name,
      subtitle: ws.repoNames.length ? ws.repoNames.join(", ") : null,
      navTarget: { type: "workspace", workspaceId: ws.id },
    });
  }

  return items;
}

/** Runs one source, logging and swallowing failures so one outage can't blank the list. */
async function safe<T>(label: string, run: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await run();
  } catch (e) {
    console.error(`[wip] ${label} failed:`, e instanceof Error ? e.message : e);
    return fallback;
  }
}

/**
 * Fetches open GitHub issues assigned to the viewer carrying any of `labels`,
 * across the repos flagged for issue tracking. GitHub's `labels` param is AND,
 * so query per label and union to get "any of these labels" (OR). Deduped by the
 * issue key.
 */
async function fetchLabeledIssues(
  db: Db,
  token: string,
  labels: string[],
): Promise<IssueSummary[]> {
  const gh = new GitHubClient(token);
  const [{ login }, repos] = await Promise.all([gh.viewer(), listIssueRepos(db)]);
  const byKey = new Map<string, IssueSummary>();
  await Promise.all(
    repos.flatMap((repo) =>
      labels.map((label) =>
        gh
          .listRepoIssues(repo.owner, repo.repo, {
            assignee: login,
            state: "open",
            labels: [label],
          })
          .then((issues) => {
            for (const issue of issues) {
              byKey.set(issueKey(issue.provider, issue.sourceKey, issue.externalId), issue);
            }
          })
          .catch((e) => {
            console.error(`[wip] labeled issues (${repo.owner}/${repo.repo}) failed:`, e);
          }),
      ),
    ),
  );
  return [...byKey.values()];
}

/**
 * Gathers the enabled sources (each degrading gracefully) per the saved config
 * and returns the ordered list. A disabled source contributes nothing.
 */
export async function getWipList(db: Db, config: Config): Promise<WipItem[]> {
  const token = config.secrets.githubToken;
  const today = new Date().toISOString().slice(0, 10);
  const { sources, issueLabels } = await getWipConfig();

  const [
    starredPrs,
    myPrs,
    inProgressIssues,
    labeledIssues,
    starredIssues,
    todayTasks,
    activeWorkspaces,
  ] = await Promise.all([
    sources.starredPrs ? safe("starred PRs", () => listPrStars(db), [] as GithubStar[]) : [],
    sources.myPrs
      ? safe(
          "my open PRs",
          async () =>
            token ? await new GitHubClient(token).search("is:pr is:open author:@me") : [],
          [] as PrSummary[],
        )
      : [],
    sources.issues
      ? safe(
          "in-progress issues",
          async () =>
            (await listLinks(db, "github")).filter((l) => l.localStatus === "in_progress"),
          [] as IssueLink[],
        )
      : [],
    token && issueLabels.length
      ? safe(
          "labeled issues",
          () => fetchLabeledIssues(db, token, issueLabels),
          [] as IssueSummary[],
        )
      : [],
    sources.issues
      ? safe("starred issues", () => listIssueStars(db, "github"), [] as IssueStar[])
      : [],
    sources.tasks
      ? safe(
          "today's tasks",
          () => listTasks(db, { status: "open", targetDate: today }),
          [] as Task[],
        )
      : [],
    sources.workspaces
      ? safe(
          "active workspaces",
          async () => (await listWorkspaces(db)).filter((w) => w.status === "active"),
          [] as WorkspaceSummary[],
        )
      : [],
  ]);

  return buildWipItems({
    starredPrs,
    myPrs,
    inProgressIssues,
    labeledIssues,
    starredIssues,
    todayTasks,
    activeWorkspaces,
  });
}
