/**
 * Frontend JIRA shapes, mirroring the sidecar's `jira/types.ts`. List rows reuse
 * the shared `IssueSummary` (with `statusName`/`statusCategory`/`issueType`
 * populated); the detail view uses the richer `JiraIssueDetail`.
 */

import type { IssueComment, IssueLabel } from "../issues/types";

export interface JiraViewer {
  login: string;
  accountId: string;
}

export interface JiraUser {
  accountId: string;
  displayName: string;
  email: string | null;
  avatarUrl: string | null;
}

export interface JiraLinkedIssue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: string;
  linkType: string;
  issueType: string;
  url: string;
}

export interface JiraTransition {
  id: string;
  name: string;
  toStatusName: string;
  toStatusCategory: string;
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
