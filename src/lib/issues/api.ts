import { sidecarFetch } from "../api";
import type {
  IssueDetail,
  IssueFilter,
  IssueLink,
  IssueProvider,
  IssueRepo,
  IssueStar,
  IssueSummary,
  StartWorkInput,
  StartWorkResult,
} from "./types";

/**
 * Frontend client for the source-agnostic issue routes (`/api/issues/:provider`).
 * `provider` defaults to "github" — the only wired provider today — so callers
 * stay terse until JIRA lands.
 */

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

/** Splits a GitHub "owner/repo" sourceKey for the detail route's path params. */
function splitSourceKey(sourceKey: string): { owner: string; repo: string } {
  const slash = sourceKey.indexOf("/");
  return { owner: sourceKey.slice(0, slash), repo: sourceKey.slice(slash + 1) };
}

export const issuesRepos = (provider: IssueProvider = "github") =>
  get<IssueRepo[]>(`/api/issues/${provider}/repos`);

export const issuesAssigned = (provider: IssueProvider = "github") =>
  get<IssueSummary[]>(`/api/issues/${provider}/assigned`);

export const issuesAll = (provider: IssueProvider = "github") =>
  get<IssueSummary[]>(`/api/issues/${provider}/all`);

export const issuesSearch = (query: string, provider: IssueProvider = "github") =>
  get<IssueSummary[]>(`/api/issues/${provider}/search?q=${encodeURIComponent(query)}`);

export function issueDetail(
  sourceKey: string,
  externalId: string,
  provider: IssueProvider = "github",
): Promise<IssueDetail> {
  const { owner, repo } = splitSourceKey(sourceKey);
  return get<IssueDetail>(`/api/issues/${provider}/detail/${owner}/${repo}/${externalId}`);
}

// --- Saved filters ---

export const issueFilters = (provider: IssueProvider = "github") =>
  get<IssueFilter[]>(`/api/issues/${provider}/filters`);

export const createIssueFilter = (
  name: string,
  query: string,
  provider: IssueProvider = "github",
) => send<IssueFilter>(`/api/issues/${provider}/filters`, "POST", { name, query });

export const deleteIssueFilter = (id: string, provider: IssueProvider = "github") =>
  send<{ deleted: boolean }>(`/api/issues/${provider}/filters/${id}`, "DELETE");

// --- Stars ---

export const issueStars = (provider: IssueProvider = "github") =>
  get<IssueStar[]>(`/api/issues/${provider}/stars`);

export const addIssueStar = (issue: IssueSummary) =>
  send<{ ok: boolean }>(`/api/issues/${issue.provider}/stars`, "POST", {
    sourceKey: issue.sourceKey,
    externalId: issue.externalId,
    title: issue.title,
    url: issue.url,
  });

export const removeIssueStar = (issue: IssueSummary) =>
  send<{ deleted: boolean }>(
    `/api/issues/${issue.provider}/stars?sourceKey=${encodeURIComponent(
      issue.sourceKey,
    )}&externalId=${encodeURIComponent(issue.externalId)}`,
    "DELETE",
  );

// --- Workspace links + local status ---

export const issueLinks = (provider: IssueProvider = "github") =>
  get<IssueLink[]>(`/api/issues/${provider}/links`);

// --- Start work ---

export const startWork = (input: StartWorkInput, provider: IssueProvider = "github") =>
  send<StartWorkResult>(`/api/issues/${provider}/start-work`, "POST", input);

export const writeIssuePromptFile = (
  workspaceId: string,
  prompt: string,
  provider: IssueProvider = "github",
) => send<{ path: string }>(`/api/issues/${provider}/prompt-file`, "POST", { workspaceId, prompt });
