/**
 * Minimal Azure Boards (work item tracking) REST client over fetch. It uses the
 * same PAT and org URL as the Azure DevOps PR client, and the org URL passes the
 * same `isAllowedAzureOrgUrl` check before any request is made (the routes
 * enforce that). The fetch implementation is injectable for tests.
 *
 * A work item is addressed by its numeric id, which is unique across the org, so
 * most calls are org-level. Comments and a type's states are project-scoped, so
 * those take the project name read off the item.
 */

import type { IssueComment, IssueLabel, IssueSummary } from "../issues/types.ts";
import { htmlToMarkdown, textToHtml } from "./html.ts";
import type {
  BoardsBodyField,
  BoardsState,
  BoardsStateCategory,
  BoardsViewer,
  BoardsWorkItemDetail,
} from "./types.ts";

type FetchFn = typeof fetch;

const API_VERSION = "7.1";
// The comments endpoints only exist under a preview version.
const COMMENTS_API_VERSION = "7.1-preview.4";

/** Azure's work item batch endpoint accepts at most 200 ids per call. */
const BATCH_LIMIT = 200;

/** How many work items a list or search returns. */
const LIST_LIMIT = 50;

/**
 * State names that mean "finished" in the built-in Agile, Scrum, Basic and CMMI
 * processes. WIQL filters on state names, not categories, so the "open items"
 * queries exclude these. A custom process with other done-state names will show
 * those items too.
 */
const DONE_STATE_NAMES = ["Closed", "Done", "Removed", "Resolved", "Completed"];

const SUMMARY_FIELDS = [
  "System.Id",
  "System.Title",
  "System.State",
  "System.WorkItemType",
  "System.AssignedTo",
  "System.CreatedBy",
  "System.CreatedDate",
  "System.ChangedDate",
  "System.Tags",
  "System.TeamProject",
  "System.CommentCount",
];

// A type's states change only when someone edits the process, but every list
// needs them to colour its rows. Module-level because the client is built per
// request; keyed by org URL, project and type.
const STATES_CACHE_TTL_MS = 10 * 60_000;
const statesCache = new Map<string, { states: BoardsState[]; ts: number }>();

/** Maps Azure's state category onto the shared to-do / in-progress / done set. */
export function mapStateCategory(category: string | undefined): BoardsStateCategory {
  switch (category) {
    case "InProgress":
      return "in_progress";
    case "Resolved":
    case "Completed":
    case "Removed":
      return "done";
    default:
      return "todo"; // "Proposed" and anything unrecognised
  }
}

/**
 * Best guess at a state's category from its name alone, used only when the
 * type's state list could not be loaded. Covers the built-in processes.
 */
function guessStateCategory(state: string): BoardsStateCategory {
  if (DONE_STATE_NAMES.some((s) => s.toLowerCase() === state.toLowerCase())) return "done";
  if (/^(active|in[\s-]?progress|committed|doing)$/i.test(state)) return "in_progress";
  return "todo";
}

/** Azure stores tags as one "a; b; c" string. */
function toIssueLabels(tags: unknown): IssueLabel[] {
  if (typeof tags !== "string") return [];
  return tags
    .split(";")
    .map((t) => t.trim())
    .filter(Boolean)
    .map((name) => ({ name, color: null }));
}

/** Quotes a value for a WIQL string literal. WIQL escapes `'` by doubling it. */
function wiqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

const OPEN_ITEMS = `[System.State] NOT IN (${DONE_STATE_NAMES.map(wiqlString).join(", ")})`;

interface RawWorkItem {
  id: number;
  fields?: Record<string, any>;
}

type JsonPatchOp = { op: "add"; path: string; value: unknown } | { op: "remove"; path: string };

/** The field that holds a work item's main text. */
const BODY_FIELDS: Record<BoardsBodyField, string> = {
  description: "System.Description",
  reproSteps: "Microsoft.VSTS.TCM.ReproSteps",
};

// The viewer is fixed for a given PAT and org, and assigning to yourself needs
// it on every call. Keyed by org URL and token so a changed PAT re-resolves.
const viewerCache = new Map<string, BoardsViewer>();

function categoryIn(states: BoardsState[] | undefined, state: string): BoardsStateCategory {
  return states?.find((s) => s.name === state)?.category ?? guessStateCategory(state);
}

function stateKey(project: string, type: string): string {
  return `${project}\n${type}`;
}

export class AzureBoardsClient {
  private readonly orgUrl: string;

  constructor(
    private readonly token: string,
    orgUrl: string,
    private readonly fetchImpl: FetchFn = fetch,
  ) {
    this.orgUrl = orgUrl.replace(/\/+$/, "");
  }

  private headers(contentType?: string): Record<string, string> {
    const h: Record<string, string> = {
      Authorization: `Basic ${btoa(`:${this.token}`)}`,
      Accept: "application/json",
    };
    if (contentType) h["Content-Type"] = contentType;
    return h;
  }

  private withVersion(url: string, version: string | null): string {
    if (version === null) return url;
    return `${url}${url.includes("?") ? "&" : "?"}api-version=${version}`;
  }

  private async request<T>(
    method: string,
    url: string,
    opts: { body?: unknown; contentType?: string; apiVersion?: string | null } = {},
  ): Promise<T> {
    const version = opts.apiVersion === undefined ? API_VERSION : opts.apiVersion;
    const hasBody = opts.body !== undefined;
    const res = await this.fetchImpl(this.withVersion(url, version), {
      method,
      headers: this.headers(hasBody ? (opts.contentType ?? "application/json") : undefined),
      body: hasBody ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) throw new Error(await this.errorText(method, url, res));
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  }

  /** Folds Azure's own error `message` into the error so a rejected field
   *  update (an invalid state, say) says why. */
  private async errorText(method: string, url: string, res: Response): Promise<string> {
    let detail = "";
    try {
      const data = (await res.json()) as { message?: string };
      if (data.message) detail = `: ${data.message}`;
    } catch {
      // Non-JSON body: the status code alone will have to do.
    }
    const path = url.startsWith(this.orgUrl) ? url.slice(this.orgUrl.length) : url;
    return `azure boards ${method} ${path} -> ${res.status}${detail}`;
  }

  private projectBase(project: string): string {
    return `${this.orgUrl}/${encodeURIComponent(project)}`;
  }

  private webUrl(project: string, id: number): string {
    return `${this.projectBase(project)}/_workitems/edit/${id}`;
  }

  // --- Identity ---

  /**
   * The authenticated user, from the org-scoped connectionData endpoint (the
   * same one the PR client uses, and unversioned for the same reason).
   */
  async viewer(): Promise<BoardsViewer> {
    const cacheKey = `${this.orgUrl}\n${this.token}`;
    const cached = viewerCache.get(cacheKey);
    if (cached) return cached;
    const data = await this.request<{
      authenticatedUser?: {
        id?: string;
        providerDisplayName?: string;
        properties?: { Account?: { $value?: string } };
      };
    }>("GET", `${this.orgUrl}/_apis/connectionData`, { apiVersion: null });
    const user = data.authenticatedUser;
    if (!user?.id) throw new Error("azure connectionData returned no authenticated user");
    const login = user.providerDisplayName ?? "";
    const viewer = { login, uniqueName: user.properties?.Account?.$value || login };
    viewerCache.set(cacheKey, viewer);
    return viewer;
  }

  // --- States ---

  /** The states a work item type allows in a project, cached briefly. */
  async typeStates(project: string, type: string): Promise<BoardsState[]> {
    const key = `${this.orgUrl}\n${stateKey(project, type)}`;
    const cached = statesCache.get(key);
    if (cached && Date.now() - cached.ts < STATES_CACHE_TTL_MS) return cached.states;
    const data = await this.request<{ value?: { name?: string; category?: string }[] }>(
      "GET",
      `${this.projectBase(project)}/_apis/wit/workitemtypes/${encodeURIComponent(type)}/states`,
    );
    const states = (data.value ?? [])
      .filter((s) => s.name)
      .map((s) => ({ name: s.name as string, category: mapStateCategory(s.category) }));
    statesCache.set(key, { states, ts: Date.now() });
    return states;
  }

  /**
   * Resolves the category of each (project, type, state) in a list. A type
   * whose states fail to load falls back to guessing from the state name, so
   * one bad lookup doesn't fail the whole list.
   */
  private async loadCategoryResolver(
    items: RawWorkItem[],
  ): Promise<(item: RawWorkItem) => BoardsStateCategory> {
    const pairs = new Map<string, { project: string; type: string }>();
    for (const item of items) {
      const f = item.fields ?? {};
      const project = f["System.TeamProject"];
      const type = f["System.WorkItemType"];
      if (project && type) pairs.set(stateKey(project, type), { project, type });
    }
    const resolved = new Map<string, BoardsState[]>();
    await Promise.all(
      [...pairs.entries()].map(async ([key, { project, type }]) => {
        try {
          resolved.set(key, await this.typeStates(project, type));
        } catch (e) {
          console.warn(
            `[azure-boards] could not load states for ${type}: ${e instanceof Error ? e.message : String(e)}`,
          );
        }
      }),
    );
    return (item) => {
      const f = item.fields ?? {};
      const state: string = f["System.State"] ?? "";
      return categoryIn(
        resolved.get(stateKey(f["System.TeamProject"], f["System.WorkItemType"])),
        state,
      );
    };
  }

  // --- Shaping ---

  private toSummary(item: RawWorkItem, category: BoardsStateCategory): IssueSummary {
    const f = item.fields ?? {};
    const project: string = f["System.TeamProject"] ?? "";
    const assignee: string | undefined = f["System.AssignedTo"]?.displayName;
    return {
      provider: "azure",
      sourceKey: project,
      sourceLabel: project,
      externalId: String(item.id),
      displayId: `#${item.id}`,
      title: f["System.Title"] ?? "",
      url: this.webUrl(project, item.id),
      state: category === "done" ? "closed" : "open",
      author: f["System.CreatedBy"]?.displayName ?? "",
      assignees: assignee ? [assignee] : [],
      labels: toIssueLabels(f["System.Tags"]),
      createdAt: f["System.CreatedDate"] ?? "",
      updatedAt: f["System.ChangedDate"] ?? "",
      commentCount: Number(f["System.CommentCount"] ?? 0),
      statusName: f["System.State"] ?? "",
      statusCategory: category,
      issueType: f["System.WorkItemType"] ?? "",
    };
  }

  // --- Queries ---

  /** Work items by id, shaped as list rows, in the order the ids were given. */
  async workItems(ids: number[]): Promise<IssueSummary[]> {
    const unique = [...new Set(ids)];
    const items: RawWorkItem[] = [];
    for (let i = 0; i < unique.length; i += BATCH_LIMIT) {
      const data = await this.request<{ value?: RawWorkItem[] }>(
        "POST",
        `${this.orgUrl}/_apis/wit/workitemsbatch`,
        {
          body: {
            ids: unique.slice(i, i + BATCH_LIMIT),
            fields: SUMMARY_FIELDS,
            // A starred item that was since deleted is skipped, not an error.
            errorPolicy: "omit",
          },
        },
      );
      // Omitted (deleted) items come back as null entries.
      items.push(...(data.value ?? []).filter((item) => item?.id));
    }
    const categoryOf = await this.loadCategoryResolver(items);
    const byId = new Map(items.map((item) => [item.id, item]));
    return unique
      .map((id) => byId.get(id))
      .filter((item): item is RawWorkItem => item !== undefined)
      .map((item) => this.toSummary(item, categoryOf(item)));
  }

  /**
   * Runs a WIQL query across the org and returns the first `LIST_LIMIT` hits.
   * A query that uses `@project` fails here, since no project is in scope.
   */
  async queryWiql(wiql: string): Promise<IssueSummary[]> {
    const data = await this.request<{ workItems?: { id: number }[] }>(
      "POST",
      `${this.orgUrl}/_apis/wit/wiql?$top=${LIST_LIMIT}`,
      { body: { query: wiql } },
    );
    const ids = (data.workItems ?? []).map((w) => w.id);
    if (ids.length === 0) return [];
    return this.workItems(ids);
  }

  /** Open work items assigned to the current user, most recently changed first. */
  assignedToMe(): Promise<IssueSummary[]> {
    return this.queryWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.AssignedTo] = @Me AND ${OPEN_ITEMS} ORDER BY [System.ChangedDate] DESC`,
    );
  }

  /** Open work items the current user created, most recently changed first. */
  createdByMe(): Promise<IssueSummary[]> {
    return this.queryWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.CreatedBy] = @Me AND ${OPEN_ITEMS} ORDER BY [System.ChangedDate] DESC`,
    );
  }

  /** Open work items whose title contains `text`. */
  searchTitle(text: string): Promise<IssueSummary[]> {
    return this.queryWiql(
      `SELECT [System.Id] FROM WorkItems WHERE [System.Title] CONTAINS ${wiqlString(text)} AND ${OPEN_ITEMS} ORDER BY [System.ChangedDate] DESC`,
    );
  }

  /** Full detail for one work item: fields, comments, and its type's states. */
  async workItemDetail(id: number): Promise<BoardsWorkItemDetail> {
    const item = await this.request<RawWorkItem>("GET", `${this.orgUrl}/_apis/wit/workitems/${id}`);
    const f = item.fields ?? {};
    const project: string = f["System.TeamProject"] ?? "";
    const type: string = f["System.WorkItemType"] ?? "";
    const [comments, states] = await Promise.all([
      this.getComments(project, id),
      // Without the states the detail still loads; the state can't be changed.
      this.typeStates(project, type).catch((e) => {
        console.warn(
          `[azure-boards] could not load states for ${type}: ${e instanceof Error ? e.message : String(e)}`,
        );
        return [] as BoardsState[];
      }),
    ]);
    const state: string = f["System.State"] ?? "";
    const category = categoryIn(states, state);
    // Bugs keep their main text in Repro Steps and often leave Description
    // empty. Edits go back to whichever field the text came from.
    const bodyField: BoardsBodyField =
      !f[BODY_FIELDS.description] && f[BODY_FIELDS.reproSteps] ? "reproSteps" : "description";
    const priority = f["Microsoft.VSTS.Common.Priority"];
    return {
      ...this.toSummary(item, category),
      commentCount: comments.total,
      body: htmlToMarkdown(f[BODY_FIELDS[bodyField]]),
      bodyField,
      comments: comments.comments,
      assignee: f["System.AssignedTo"]?.displayName ?? null,
      // Repeated from the summary so the detail type can require them.
      statusName: state,
      statusCategory: category,
      issueType: type,
      priority: priority === undefined || priority === null ? null : String(priority),
      states,
    };
  }

  /** The item's current state and the states its type allows, without the
   *  comments and body a full detail load fetches. */
  async stateInfo(id: number): Promise<{ state: string; states: BoardsState[] }> {
    const item = await this.request<RawWorkItem>(
      "GET",
      `${this.orgUrl}/_apis/wit/workitems/${id}?fields=System.State,System.TeamProject,System.WorkItemType`,
    );
    const f = item.fields ?? {};
    const states = await this.typeStates(
      f["System.TeamProject"] ?? "",
      f["System.WorkItemType"] ?? "",
    );
    return { state: f["System.State"] ?? "", states };
  }

  /** Up to the first 200 comments, oldest first, with the item's total count. */
  private async getComments(
    project: string,
    id: number,
  ): Promise<{ comments: IssueComment[]; total: number }> {
    const data = await this.request<{ comments?: any[]; totalCount?: number }>(
      "GET",
      `${this.projectBase(project)}/_apis/wit/workItems/${id}/comments?$top=200&order=asc`,
      { apiVersion: COMMENTS_API_VERSION },
    );
    const comments = (data.comments ?? []).map((c) => this.toComment(c));
    return { comments, total: data.totalCount ?? comments.length };
  }

  private toComment(c: any): IssueComment {
    return {
      author: c?.createdBy?.displayName ?? "",
      body: htmlToMarkdown(c?.text),
      createdAt: c?.createdDate ?? "",
    };
  }

  // --- Mutations ---

  private async patch(id: number, ops: JsonPatchOp[]): Promise<void> {
    if (ops.length === 0) return;
    await this.request("PATCH", `${this.orgUrl}/_apis/wit/workitems/${id}`, {
      body: ops,
      contentType: "application/json-patch+json",
    });
  }

  /**
   * Updates editable fields. Only the provided keys are sent. `description` and
   * `reproSteps` are plain text converted to HTML; `tags` replaces the full set.
   */
  async updateFields(
    id: number,
    input: { title?: string; description?: string; reproSteps?: string; tags?: string[] },
  ): Promise<void> {
    const ops: JsonPatchOp[] = [];
    if (input.title !== undefined) {
      ops.push({ op: "add", path: "/fields/System.Title", value: input.title });
    }
    for (const field of ["description", "reproSteps"] as const) {
      const text = input[field];
      if (text !== undefined) {
        ops.push({ op: "add", path: `/fields/${BODY_FIELDS[field]}`, value: textToHtml(text) });
      }
    }
    if (input.tags !== undefined) {
      ops.push({ op: "add", path: "/fields/System.Tags", value: input.tags.join("; ") });
    }
    await this.patch(id, ops);
  }

  /** Moves the work item to a state its type allows. */
  async setState(id: number, state: string): Promise<void> {
    await this.patch(id, [{ op: "add", path: "/fields/System.State", value: state }]);
  }

  /** Assigns the work item to a user by unique name, or unassigns it when null. */
  async assign(id: number, uniqueName: string | null): Promise<void> {
    const path = "/fields/System.AssignedTo";
    await this.patch(id, [
      uniqueName === null ? { op: "remove", path } : { op: "add", path, value: uniqueName },
    ]);
  }

  /** Posts a plain-text comment (stored as HTML) and returns it shaped. */
  async addComment(id: number, text: string): Promise<IssueComment> {
    // The comments endpoint is project-scoped, and the caller only has the id.
    const item = await this.request<RawWorkItem>(
      "GET",
      `${this.orgUrl}/_apis/wit/workitems/${id}?fields=System.TeamProject`,
    );
    const project: string = item.fields?.["System.TeamProject"] ?? "";
    const c = await this.request<any>(
      "POST",
      `${this.projectBase(project)}/_apis/wit/workItems/${id}/comments`,
      { body: { text: textToHtml(text) }, apiVersion: COMMENTS_API_VERSION },
    );
    return this.toComment(c);
  }
}
