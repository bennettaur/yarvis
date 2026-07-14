/**
 * JIRA-specific shapes that extend the provider-neutral issue types with the
 * extra detail the JIRA issue view edits: workflow transitions, linked issues,
 * the assignee's account id (needed to re-assign), and project/type metadata for
 * the create dialog. List rows reuse the shared `IssueSummary` (with its
 * optional `statusName`/`statusCategory`/`issueType` fields populated).
 */

import type { IssueDetail } from "../issues/types.ts";

/**
 * The three JIRA status categories, normalized from the API's category keys
 * ("new"/"indeterminate"/"done"). Used to group and colour rows and to pick the
 * in-progress transition when starting work.
 */
export type JiraStatusCategory = "todo" | "in_progress" | "done";

/** The authenticated JIRA user. `login` mirrors `IssueViewer` for shared code. */
export interface JiraViewer {
  login: string;
  accountId: string;
}

/** A JIRA user as returned by the assignable-user search / issue fields. */
export interface JiraUser {
  accountId: string;
  displayName: string;
  email: string | null;
}

/** An issue linked to this one (blocks / is blocked by / relates to …). */
export interface JiraLinkedIssue {
  key: string;
  summary: string;
  statusName: string;
  statusCategory: JiraStatusCategory;
  /** Human relationship label, e.g. "blocks", "is blocked by", "relates to". */
  linkType: string;
  issueType: string;
  url: string;
}

/** A workflow transition available from the issue's current status. */
export interface JiraTransition {
  id: string;
  name: string;
  toStatusName: string;
  toStatusCategory: JiraStatusCategory;
}

/** Rich JIRA detail for the issue detail view. */
export interface JiraIssueDetail extends IssueDetail {
  /** The reporter (issue creator). Duplicated from `author` for an explicit
   *  field the detail view labels "Reporter". */
  reporter: string;
  assignee: string | null;
  assigneeAccountId: string | null;
  statusName: string;
  statusCategory: string;
  issueType: string;
  priority: string | null;
  linkedIssues: JiraLinkedIssue[];
  transitions: JiraTransition[];
}

/** A JIRA project, for the create-issue dialog and project grouping. */
export interface JiraProject {
  id: string;
  key: string;
  name: string;
}

/** An issue type available in a project (Bug, Story, Task, Sub-task…). */
export interface JiraIssueType {
  id: string;
  name: string;
  subtask: boolean;
}
