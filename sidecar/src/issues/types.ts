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

/**
 * The sets a repo offers when editing an issue's labels and assignees. Both are
 * curated per repo on GitHub — labels carry the repo's colours, and only users
 * with access can be assigned — so the editors pick from these rather than
 * accepting free text that the provider would reject or silently create.
 */
export interface IssueRepoMeta {
  labels: IssueLabel[];
  assignees: string[];
  /**
   * Whether each set filled its page, meaning the repo has more than is listed.
   * Tracked separately so a repo with many labels and few collaborators doesn't
   * warn about a short assignee list that is in fact complete.
   */
  truncated: { labels: boolean; assignees: boolean };
}
