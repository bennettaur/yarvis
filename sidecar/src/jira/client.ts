/**
 * Minimal JIRA Cloud REST v3 client over fetch (no SDK dependency). The fetch
 * implementation is injectable so response shaping can be unit-tested, mirroring
 * the GitHub and Azure DevOps clients.
 *
 * Identity differs from GitHub: an issue is addressed by its key ("PROJ-45");
 * the project key is the grouping `sourceKey`. Auth is HTTP Basic with
 * `email:apiToken` (JIRA Cloud's REST scheme), so the client holds all three of
 * base URL, email, and token. The base URL is user-supplied, so — like Azure's
 * org URL — it is validated against an allowlist before any credential is sent.
 */

import type { IssueComment, IssueLabel, IssueSummary } from "../issues/types.ts";
import { adfToMarkdown, textToAdf } from "./adf.ts";
import type {
  JiraIssueDetail,
  JiraIssueType,
  JiraLinkedIssue,
  JiraProject,
  JiraStatusCategory,
  JiraTransition,
  JiraUser,
  JiraViewer,
} from "./types.ts";

type FetchFn = typeof fetch;

/** JIRA Cloud sites are always on atlassian.net; custom domains aren't supported. */
const ALLOWED_JIRA_HOST_SUFFIX = ".atlassian.net";

/**
 * True when `baseUrl` is an https JIRA Cloud site URL. The API token is sent in
 * the Authorization header on every request to this host, so an unvalidated
 * value would let a malformed/hostile URL exfiltrate the credential — the same
 * hardening the Azure client applies to its user-supplied org URL.
 */
export function isAllowedJiraBaseUrl(baseUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  return url.hostname.endsWith(ALLOWED_JIRA_HOST_SUFFIX);
}

/** Fields fetched for a list row. Kept lean; detail adds description/comments. */
const SUMMARY_FIELDS = [
  "summary",
  "status",
  "labels",
  "assignee",
  "reporter",
  "issuetype",
  "priority",
  "created",
  "updated",
  "project",
];

const DETAIL_FIELDS = [...SUMMARY_FIELDS, "description", "issuelinks"];

/** Maps a JIRA statusCategory key onto the shared token used for grouping/colour. */
function mapStatusCategory(key: string | undefined): JiraStatusCategory {
  switch (key) {
    case "done":
      return "done";
    case "indeterminate":
      return "in_progress";
    default:
      return "todo"; // "new" and anything unrecognised
  }
}

function toIssueLabels(raw: unknown): IssueLabel[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((l): l is string => typeof l === "string")
    .map((name) => ({ name, color: null }));
}

export class JiraClient {
  private readonly baseUrl: string;
  private readonly apiBase: string;

  constructor(
    baseUrl: string,
    private readonly email: string,
    private readonly token: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    this.apiBase = `${this.baseUrl}/rest/api/3`;
  }

  private authHeader(): string {
    return `Basic ${btoa(`${this.email}:${this.token}`)}`;
  }

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: this.authHeader(),
      Accept: "application/json",
    };
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async get<T>(path: string): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, { headers: this.headers() });
    if (!res.ok) throw new Error(await this.errorText("GET", path, res));
    return (await res.json()) as T;
  }

  private async send<T>(method: string, path: string, body: unknown): Promise<T> {
    const res = await this.fetchImpl(`${this.apiBase}${path}`, {
      method,
      headers: this.headers(true),
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(await this.errorText(method, path, res));
    // Some mutations (assignee, transition) return 204 with no body.
    if (res.status === 204) return undefined as T;
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /**
   * Builds an error string from a failed response, folding in JIRA's own
   * `errorMessages`/`errors` when present so a validation failure (e.g. an
   * unknown field on update) is legible rather than a bare status code. The
   * body here is JIRA's error payload, not our credentials.
   */
  private async errorText(method: string, path: string, res: Response): Promise<string> {
    let detail = "";
    try {
      const data = (await res.json()) as {
        errorMessages?: string[];
        errors?: Record<string, string>;
      };
      const parts = [...(data.errorMessages ?? []), ...Object.values(data.errors ?? {})];
      if (parts.length > 0) detail = `: ${parts.join("; ")}`;
    } catch {
      // Non-JSON body — the status code alone will have to do.
    }
    return `jira ${method} ${path} -> ${res.status}${detail}`;
  }

  private browseUrl(key: string): string {
    return `${this.baseUrl}/browse/${key}`;
  }

  // --- Identity ---

  async myself(): Promise<JiraViewer> {
    const me = await this.get<{ accountId: string; displayName?: string }>("/myself");
    return { login: me.displayName ?? "", accountId: me.accountId };
  }

  // --- Shaping ---

  private toSummary(issue: any): IssueSummary {
    const f = issue.fields ?? {};
    const projectKey: string = f.project?.key ?? issue.key.replace(/-\d+$/, "");
    const statusCategory = mapStatusCategory(f.status?.statusCategory?.key);
    return {
      provider: "jira",
      sourceKey: projectKey,
      sourceLabel: f.project?.name ?? projectKey,
      externalId: issue.key,
      displayId: issue.key,
      title: f.summary ?? "",
      url: this.browseUrl(issue.key),
      state: statusCategory === "done" ? "closed" : "open",
      author: f.reporter?.displayName ?? "",
      assignees: f.assignee?.displayName ? [f.assignee.displayName] : [],
      labels: toIssueLabels(f.labels),
      createdAt: f.created ?? "",
      updatedAt: f.updated ?? "",
      // List queries don't fetch the comment field, so summaries carry 0; the
      // detail view sets the real count from the comments it loads.
      commentCount: 0,
      statusName: f.status?.name ?? "",
      statusCategory,
      issueType: f.issuetype?.name ?? "",
    };
  }

  private toLinkedIssues(raw: any[]): JiraLinkedIssue[] {
    return (raw ?? [])
      .map((link): JiraLinkedIssue | null => {
        const linked = link.inwardIssue ?? link.outwardIssue;
        if (!linked) return null;
        const linkType = link.inwardIssue ? (link.type?.inward ?? "") : (link.type?.outward ?? "");
        const linkedFields = linked.fields ?? {};
        return {
          key: linked.key,
          summary: linkedFields.summary ?? "",
          statusName: linkedFields.status?.name ?? "",
          statusCategory: mapStatusCategory(linkedFields.status?.statusCategory?.key),
          linkType,
          issueType: linkedFields.issuetype?.name ?? "",
          url: this.browseUrl(linked.key),
        };
      })
      .filter((l): l is JiraLinkedIssue => l !== null);
  }

  // --- Queries ---

  /**
   * Runs a JQL query via the enhanced search endpoint and shapes each hit into a
   * provider-neutral IssueSummary. `maxResults` bounds the page (the dashboard
   * caps its scopes at 20).
   */
  async searchIssues(jql: string, maxResults = 50): Promise<IssueSummary[]> {
    const params = new URLSearchParams({
      jql,
      maxResults: String(maxResults),
      fields: SUMMARY_FIELDS.join(","),
    });
    const data = await this.get<{ issues?: any[] }>(`/search/jql?${params.toString()}`);
    return (data.issues ?? []).map((i) => this.toSummary(i));
  }

  /** Open issues assigned to the current user (limit 20), most-recent first. */
  assignedToMe(): Promise<IssueSummary[]> {
    return this.searchIssues(
      "assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      20,
    );
  }

  /**
   * Open issues reported by the current user (limit 20). "Created by me" maps to
   * `reporter` — the field the detail view surfaces — which defaults to the
   * creator.
   */
  createdByMe(): Promise<IssueSummary[]> {
    return this.searchIssues(
      "reporter = currentUser() AND statusCategory != Done ORDER BY updated DESC",
      20,
    );
  }

  /** Full detail for one issue: fields, comments, linked issues, transitions. */
  async issueDetail(key: string): Promise<JiraIssueDetail> {
    const [issue, comments, transitions] = await Promise.all([
      this.get<any>(`/issue/${encodeURIComponent(key)}?fields=${DETAIL_FIELDS.join(",")}`),
      this.getComments(key),
      this.transitions(key),
    ]);
    const f = issue.fields ?? {};
    return {
      ...this.toSummary(issue),
      commentCount: comments.length,
      body: adfToMarkdown(f.description),
      comments,
      reporter: f.reporter?.displayName ?? "",
      assignee: f.assignee?.displayName ?? null,
      assigneeAccountId: f.assignee?.accountId ?? null,
      statusName: f.status?.name ?? "",
      statusCategory: mapStatusCategory(f.status?.statusCategory?.key),
      issueType: f.issuetype?.name ?? "",
      priority: f.priority?.name ?? null,
      linkedIssues: this.toLinkedIssues(f.issuelinks),
      transitions,
    };
  }

  private async getComments(key: string): Promise<IssueComment[]> {
    const data = await this.get<{ comments?: any[] }>(
      `/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`,
    );
    return (data.comments ?? []).map((c) => ({
      author: c.author?.displayName ?? "",
      body: adfToMarkdown(c.body),
      createdAt: c.created ?? "",
    }));
  }

  async transitions(key: string): Promise<JiraTransition[]> {
    const data = await this.get<{ transitions?: any[] }>(
      `/issue/${encodeURIComponent(key)}/transitions`,
    );
    return (data.transitions ?? []).map((t) => ({
      id: String(t.id),
      name: t.name ?? "",
      toStatusName: t.to?.name ?? "",
      toStatusCategory: mapStatusCategory(t.to?.statusCategory?.key),
    }));
  }

  // --- Mutations ---

  /** Applies a workflow transition (status change) by transition id. */
  async transitionIssue(key: string, transitionId: string): Promise<void> {
    await this.send("POST", `/issue/${encodeURIComponent(key)}/transitions`, {
      transition: { id: transitionId },
    });
  }

  /** Assigns the issue to an account, or unassigns it when `accountId` is null. */
  async assign(key: string, accountId: string | null): Promise<void> {
    await this.send("PUT", `/issue/${encodeURIComponent(key)}/assignee`, { accountId });
  }

  /**
   * Updates editable issue fields. Only the provided keys are sent; `description`
   * is a plain-text string converted to ADF, `labels` replaces the full set.
   */
  async updateFields(
    key: string,
    input: { summary?: string; description?: string; labels?: string[] },
  ): Promise<void> {
    const fields: Record<string, unknown> = {};
    if (input.summary !== undefined) fields.summary = input.summary;
    if (input.description !== undefined) fields.description = textToAdf(input.description);
    if (input.labels !== undefined) fields.labels = input.labels;
    if (Object.keys(fields).length === 0) return;
    await this.send("PUT", `/issue/${encodeURIComponent(key)}`, { fields });
  }

  /** Posts a comment (plain text, stored as ADF) and returns the shaped comment. */
  async addComment(key: string, text: string): Promise<IssueComment> {
    const c = await this.send<any>("POST", `/issue/${encodeURIComponent(key)}/comment`, {
      body: textToAdf(text),
    });
    return {
      author: c?.author?.displayName ?? "",
      body: adfToMarkdown(c?.body),
      createdAt: c?.created ?? "",
    };
  }

  /**
   * Creates an issue and returns its shaped summary. `description` is plain text
   * (converted to ADF); `issueTypeName` names the type (e.g. "Task", "Bug").
   */
  async createIssue(input: {
    projectKey: string;
    summary: string;
    description?: string;
    issueTypeName: string;
  }): Promise<IssueSummary> {
    const fields: Record<string, unknown> = {
      project: { key: input.projectKey },
      summary: input.summary,
      issuetype: { name: input.issueTypeName },
    };
    if (input.description) fields.description = textToAdf(input.description);
    const created = await this.send<{ key: string }>("POST", "/issue", { fields });
    return this.issueSummaryByKey(created.key);
  }

  /** Fetches one issue as a summary (used after create to return a full row). */
  async issueSummaryByKey(key: string): Promise<IssueSummary> {
    const issue = await this.get<any>(
      `/issue/${encodeURIComponent(key)}?fields=${SUMMARY_FIELDS.join(",")}`,
    );
    return this.toSummary(issue);
  }

  // --- Metadata (create dialog + assignee picker) ---

  async listProjects(): Promise<JiraProject[]> {
    const data = await this.get<{ values?: any[] }>("/project/search?maxResults=100&orderBy=name");
    return (data.values ?? []).map((p) => ({
      id: String(p.id),
      key: p.key,
      name: p.name ?? p.key,
    }));
  }

  async projectIssueTypes(projectKey: string): Promise<JiraIssueType[]> {
    const project = await this.get<{ issueTypes?: any[] }>(
      `/project/${encodeURIComponent(projectKey)}`,
    );
    return (project.issueTypes ?? []).map((t) => ({
      id: String(t.id),
      name: t.name ?? "",
      subtask: Boolean(t.subtask),
    }));
  }

  private toUser(u: any): JiraUser {
    return {
      accountId: u.accountId,
      displayName: u.displayName ?? "",
      email: u.emailAddress ?? null,
    };
  }

  /** Users assignable to an existing issue, matching `query`. */
  async searchAssignableUsers(key: string, query: string): Promise<JiraUser[]> {
    const params = new URLSearchParams({ issueKey: key, query, maxResults: "20" });
    const data = await this.get<any[]>(`/user/assignable/search?${params.toString()}`);
    return (data ?? []).map((u) => this.toUser(u));
  }
}
