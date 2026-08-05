/**
 * Frontend JIRA shapes, mirroring the sidecar's `jira/types.ts`. List rows reuse
 * the shared `IssueSummary` (with `statusName`/`statusCategory`/`issueType`
 * populated); the detail view uses the richer `JiraIssueDetail`.
 */

import type { IssueComment, IssueLabel } from "../issues/types";

/** Normalized JIRA status category (see sidecar jira/types.ts). */
export type JiraStatusCategory = "todo" | "in_progress" | "done";

export interface JiraViewer {
  login: string;
  accountId: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  email: string | null;
}

export interface JiraLinkedIssue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: JiraStatusCategory;
  linkType: string;
  issueType: string;
  url: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatusName: string;
  toStatusCategory: JiraStatusCategory;
}

export interface JiraIssueDetail {
  provider: "jira";
  sourceKey: string;
  sourceLabel: string;
  externalId: string;
  displayId: string;
  title: string;
  url: string;
  state: string;
  author: string;
  assignees: string[];
  labels: IssueLabel[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  statusName?: string;
  statusCategory?: string;
  issueType?: string;
  body: string;
  comments: IssueComment[];
  reporter: string;
  assignee: string | null;
  assigneeAccountId: string | null;
  priority: string | null;
  linkedIssues: JiraLinkedIssue[];
  transitions: JiraTransition[];
}

export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}

/** What the user picks in the Start Work dialog: the repos the workspace is
 *  built from, and the status the ticket moves to (if any). */
export interface StartWorkChoice {
  repoIds: string[];
  transitionToInProgress: boolean;
  transitionId?: string;
}
