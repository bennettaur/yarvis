/**
 * Frontend issue shapes, mirroring the sidecar's provider-neutral issue types
 * (`sidecar/src/issues/types.ts`). An issue is keyed by the source-agnostic
 * triple (provider, sourceKey, externalId) so JIRA slots in beside GitHub.
 */

export type IssueProvider = "github" | "jira";

export interface IssueLabel {
  name: string;
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
  state: string;
  author: string;
  assignees: string[];
  labels: IssueLabel[];
  createdAt: string;
  updatedAt: string;
  commentCount: number;
  /** JIRA workflow status/type; unset for GitHub (see sidecar issues/types.ts). */
  statusName?: string;
  statusCategory?: string;
  issueType?: string;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
}

export interface IssueDetail extends IssueSummary {
  body: string;
  comments: IssueComment[];
}

export interface IssueCreateInput {
  title: string;
  body?: string;
}

/** A partial issue edit; at least one field must be set. */
export interface IssueUpdateInput {
  title?: string;
  body?: string;
  state?: "open" | "closed";
}

/** A repo configured to pull issues, as the /repos route returns it. */
export interface IssueRepo {
  id: string;
  owner: string;
  repo: string;
  name: string;
}

export interface IssueFilter {
  id: string;
  provider: string;
  name: string;
  query: string;
  createdAt: string;
}

export interface IssueStar {
  id: string;
  provider: string;
  sourceKey: string;
  externalId: string;
  title: string | null;
  url: string | null;
  createdAt: string;
}

export type IssueLocalStatus = "todo" | "in_progress" | "done";

/** Link between an issue and the workspace opened to work on it. */
export interface IssueLink {
  id: string;
  provider: string;
  sourceKey: string;
  externalId: string;
  title: string | null;
  url: string | null;
  localStatus: IssueLocalStatus;
  workspaceId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface StartWorkInput {
  sourceKey: string;
  externalId: string;
  title: string;
  body: string;
  url?: string | null;
  assignSelf?: boolean;
  applyLabel?: boolean;
  label?: string;
}

export interface StartWorkResult {
  workspaceId: string;
  warnings: string[];
}

/** Stable key for an issue across list/star/link joins. Includes `provider` so
 * a future second source can't collide with a GitHub issue of the same id. */
export function issueKey(provider: string, sourceKey: string, externalId: string): string {
  return `${provider}:${sourceKey}#${externalId}`;
}
