import { ensureOk, sidecarFetch } from "../api";
import type { IssueComment, IssueSummary, StartWorkResult } from "../issues/types";
import type { JiraIssueDetail, JiraIssueType, JiraProject, JiraUser, JiraViewer } from "./types";

/**
 * Frontend client for the JIRA routes (`/api/jira`). Unlike the shared issue
 * routes, JIRA issues are addressed by key ("PROJ-45") and support live field
 * edits, transitions, comments, and issue creation.
 */

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  await ensureOk(res, path);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  await ensureOk(res, path);
  return res.json();
}

/** The authenticated JIRA user — also the "is JIRA configured & working" probe. */
export const jiraViewer = () => get<JiraViewer>("/api/jira/viewer");

export const jiraAssigned = () => get<IssueSummary[]>("/api/jira/assigned");

export const jiraCreated = () => get<IssueSummary[]>("/api/jira/created");

export const jiraSearch = (jql: string) =>
  get<IssueSummary[]>(`/api/jira/search?jql=${encodeURIComponent(jql)}`);

export const jiraIssueDetail = (key: string) =>
  get<JiraIssueDetail>(`/api/jira/issue/${encodeURIComponent(key)}`);

// --- Field edits (each returns the refreshed detail) ---

export const jiraUpdateFields = (
  key: string,
  fields: { summary?: string; description?: string; labels?: string[] },
) => send<JiraIssueDetail>(`/api/jira/issue/${encodeURIComponent(key)}`, "PATCH", fields);

export const jiraTransition = (key: string, transitionId: string) =>
  send<JiraIssueDetail>(`/api/jira/issue/${encodeURIComponent(key)}/transition`, "POST", {
    transitionId,
  });

export const jiraAssign = (key: string, accountId: string | null) =>
  send<JiraIssueDetail>(`/api/jira/issue/${encodeURIComponent(key)}/assignee`, "PUT", {
    accountId,
  });

export const jiraAddComment = (key: string, body: string) =>
  send<IssueComment>(`/api/jira/issue/${encodeURIComponent(key)}/comment`, "POST", { body });

export const jiraAssignableUsers = (key: string, query: string) =>
  get<JiraUser[]>(
    `/api/jira/issue/${encodeURIComponent(key)}/assignable?query=${encodeURIComponent(query)}`,
  );

// --- Create issue + metadata ---

export const jiraProjects = () => get<JiraProject[]>("/api/jira/projects");

export const jiraProjectIssueTypes = (projectKey: string) =>
  get<JiraIssueType[]>(`/api/jira/projects/${encodeURIComponent(projectKey)}/issue-types`);

export interface JiraCreateInput {
  projectKey: string;
  summary: string;
  issueTypeName: string;
  description?: string;
}

export const jiraCreateIssue = (input: JiraCreateInput) =>
  send<IssueSummary>("/api/jira/issues", "POST", input);

// --- Start work ---

export interface JiraStartWorkInput {
  sourceKey: string;
  externalId: string;
  title: string;
  body: string;
  url?: string | null;
  repoIds: string[];
  assignSelf?: boolean;
  transitionToInProgress?: boolean;
  /** Explicit target transition; falls back to the in-progress heuristic. */
  transitionId?: string;
}

export const jiraStartWork = (input: JiraStartWorkInput) =>
  send<StartWorkResult>("/api/jira/start-work", "POST", input);
