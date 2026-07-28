/**
 * Provider-neutral issue shapes shared by ticket-system providers (GitHub
 * Issues today, JIRA later). Both providers map their native API responses onto
 * these types so the frontend renders one Issues view regardless of source.
 *
 * An issue is identified by the source-agnostic triple used across the schema:
 *  - `provider`   — "github" | "jira"
 *  - `sourceKey`  — the grouping key (GitHub "owner/repo"; JIRA project key)
 *  - `externalId` — the canonical id (GitHub issue number as a string; JIRA key)
 * `displayId` is the human label ("#123" / "PROJ-45"); `sourceLabel` is the
 * group header text.
 */

export type IssueProvider = "github" | "jira";

export interface IssueLabel {
  name: string;
  /** Hex color without the leading '#', or null when the provider has none. */
  color: string | null;
}

export interface IssueSummary {
  provider: IssueProvider;
  sourceKey: string;
  sourceLabel: string;
  externalId: string;
  displayId: string;
  title: string;
  url: string;
  /** "open" | "closed". */
  state: string;
  author: string;
  assignees: string[];
  labels: IssueLabel[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /**
   * Workflow status. JIRA carries the status name ("In Progress") and its
   * category ("todo" | "in_progress" | "done") used to group and colour rows;
   * GitHub leaves these unset and relies on `state`. `issueType` is the JIRA
   * type ("Bug", "Story"…) and is likewise absent for GitHub.
   */
  statusName?: string;
  statusCategory?: string;
  issueType?: string;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

/** Rich detail for the issue detail view (body + comments on top of the summary). */
export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
}

export interface IssueViewer {
  login: string;
}
