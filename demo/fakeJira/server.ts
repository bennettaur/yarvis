/**
 * A stand-in for a JIRA Cloud site's REST API (v3), answering the calls the
 * sidecar's `JiraClient` makes from the tickets in `data.ts`. The sidecar finds
 * it through YARVIS_JIRA_API_URL. Status changes, assignments, edits, comments
 * and new tickets are kept for the run, so a flow sees what it changed.
 *
 * JQL isn't parsed properly: `matchesJql` recognises the handful of clauses
 * the app builds and ignores any others. A query with no operator at all is
 * the Search tab's free text.
 */

import type { Server } from "node:http";
import { type FakeRequest, type FakeResponse, startFakeServer } from "../fakeHttp";
import {
  type FakeTicket,
  ISSUE_TYPES,
  PEOPLE,
  PROJECT,
  STATUSES,
  type StatusName,
  TICKETS,
  VIEWER,
} from "./data";

/** The tickets as this run has left them. Copied, so the seed data in `data.ts` stays as written. */
const tickets: FakeTicket[] = TICKETS.map((t) => ({
  ...t,
  comments: [...t.comments],
  labels: [...t.labels],
}));

const findTicket = (key: string) => tickets.find((t) => t.key === key);

interface AdfNode {
  type?: string;
  text?: string;
  content?: AdfNode[];
}

/** Plain text as Atlassian Document Format, one paragraph per blank-line-separated block. */
function toAdf(text: string): AdfNode & { version: number } {
  return {
    type: "doc",
    version: 1,
    content: text
      .split(/\n{2,}/)
      .map((para) => ({ type: "paragraph", content: [{ type: "text", text: para }] })),
  };
}

/** The text of an ADF document, paragraphs separated by a blank line. */
function fromAdf(node: AdfNode | undefined): string {
  if (!node) return "";
  if (node.type === "text") return node.text ?? "";
  const parts = (node.content ?? []).map(fromAdf);
  return node.type === "doc" ? parts.join("\n\n") : parts.join("");
}

const statusNamed = (name: StatusName) => STATUSES.find((s) => s.name === name) ?? STATUSES[0];

function statusOf(name: StatusName) {
  const status = statusNamed(name);
  return { name: status.name, statusCategory: { key: status.category } };
}

const toComment = (c: FakeTicket["comments"][number]) => ({
  author: c.author,
  body: toAdf(c.text),
  created: c.createdAt,
});

function toFields(t: FakeTicket) {
  return {
    summary: t.summary,
    status: statusOf(t.status),
    labels: t.labels,
    assignee: t.assignee,
    reporter: t.reporter,
    issuetype: { name: t.issueType },
    priority: { name: t.priority },
    created: t.createdAt,
    updated: t.updatedAt,
    project: { key: PROJECT.key, name: PROJECT.name },
    description: toAdf(t.description),
    issuelinks: t.blocks.flatMap((key) => {
      const linked = findTicket(key);
      if (!linked) return [];
      return [
        {
          type: { inward: "is blocked by", outward: "blocks" },
          outwardIssue: {
            key,
            fields: {
              summary: linked.summary,
              status: statusOf(linked.status),
              issuetype: { name: linked.issueType },
            },
          },
        },
      ];
    }),
  };
}

const toIssue = (t: FakeTicket) => ({ key: t.key, fields: toFields(t) });

/** Whether `t` matches the queries the app builds; see the module comment. */
export function matchesJql(t: FakeTicket, jql: string): boolean {
  const query = jql.replace(/ORDER BY.*$/i, "").trim();
  const keys = query.match(/issuekey in \(([^)]*)\)/i)?.[1];
  if (keys !== undefined) return keys.split(",").some((k) => k.trim() === t.key);
  if (/^[A-Z]+-\d+$/.test(query)) return t.key === query;

  const isDone = statusNamed(t.status).category === "done";
  if (/statusCategory != Done/i.test(query) && isDone) return false;
  if (/assignee = currentUser\(\)/i.test(query) && t.assignee?.accountId !== VIEWER.accountId) {
    return false;
  }
  if (/reporter = currentUser\(\)/i.test(query) && t.reporter.accountId !== VIEWER.accountId) {
    return false;
  }
  const quotedText = query.match(/text ~ "([^"]*)"/i)?.[1];
  const isBareText = !/[=~]/.test(query);
  const words = (quotedText ?? (isBareText ? query : "")).toLowerCase();
  return !words || `${t.summary} ${t.description}`.toLowerCase().includes(words);
}

function transitionsFor(t: FakeTicket) {
  return STATUSES.filter((s) => s.name !== t.status).map((s) => ({
    id: s.transitionId,
    name: s.name,
    to: { name: s.name, statusCategory: { key: s.category } },
  }));
}

function markUpdated(t: FakeTicket): void {
  t.updatedAt = new Date().toISOString();
}

function nextKey(): string {
  const highest = Math.max(...tickets.map((t) => Number(t.key.split("-")[1])));
  return `${PROJECT.key}-${highest + 1}`;
}

export function handleJiraRequest({ method, url, body }: FakeRequest): FakeResponse {
  const path = url.pathname.replace(/^\/rest\/api\/3/, "");
  if (method === "GET" && path === "/myself") return { json: VIEWER };

  if (method === "GET" && path === "/search/jql") {
    const jql = url.searchParams.get("jql") ?? "";
    const max = Number(url.searchParams.get("maxResults") ?? 50);
    const hits = tickets
      .filter((t) => matchesJql(t, jql))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      .slice(0, max);
    return { json: { issues: hits.map(toIssue) } };
  }

  if (method === "GET" && path === "/project/search") return { json: { values: [PROJECT] } };
  if (method === "GET" && path === `/project/${PROJECT.key}`) {
    return { json: { ...PROJECT, issueTypes: ISSUE_TYPES } };
  }
  if (method === "GET" && path === "/user/assignable/search") {
    const query = (url.searchParams.get("query") ?? "").toLowerCase();
    return { json: PEOPLE.filter((p) => p.displayName.toLowerCase().includes(query)) };
  }

  if (method === "POST" && path === "/issue") {
    const { fields } = body as {
      fields: { summary: string; issuetype: { name: string }; description?: AdfNode };
    };
    const now = new Date().toISOString();
    const ticket: FakeTicket = {
      key: nextKey(),
      summary: fields.summary,
      description: fromAdf(fields.description),
      issueType: fields.issuetype.name,
      priority: "Medium",
      status: "To Do",
      assignee: null,
      reporter: VIEWER,
      labels: [],
      createdAt: now,
      updatedAt: now,
      comments: [],
      blocks: [],
    };
    tickets.unshift(ticket);
    return { status: 201, json: { id: ticket.key, key: ticket.key } };
  }

  const [, key, rest = ""] = path.match(/^\/issue\/([^/]+)(\/.*)?$/) ?? [];
  if (!key) return { status: 404, json: { errorMessages: [`No route for ${path}`], errors: {} } };
  const ticket = findTicket(decodeURIComponent(key));
  if (!ticket) {
    return { status: 404, json: { errorMessages: ["Issue does not exist"], errors: {} } };
  }

  if (rest === "" && method === "GET") return { json: toIssue(ticket) };
  if (rest === "" && method === "PUT") {
    const { fields } = body as {
      fields: { summary?: string; description?: AdfNode; labels?: string[] };
    };
    if (fields.summary !== undefined) ticket.summary = fields.summary;
    if (fields.description !== undefined) ticket.description = fromAdf(fields.description);
    if (fields.labels !== undefined) ticket.labels = fields.labels;
    markUpdated(ticket);
    return { status: 204 };
  }
  if (rest === "/comment" && method === "GET") {
    return { json: { comments: ticket.comments.map(toComment) } };
  }
  if (rest === "/comment" && method === "POST") {
    const comment = {
      author: VIEWER,
      text: fromAdf((body as { body: AdfNode }).body),
      createdAt: new Date().toISOString(),
    };
    ticket.comments.push(comment);
    markUpdated(ticket);
    return { status: 201, json: toComment(comment) };
  }
  if (rest === "/transitions" && method === "GET") {
    return { json: { transitions: transitionsFor(ticket) } };
  }
  if (rest === "/transitions" && method === "POST") {
    const id = (body as { transition: { id: string } }).transition.id;
    const target = STATUSES.find((s) => s.transitionId === id);
    if (!target) return { status: 400, json: { errorMessages: ["Unknown transition"] } };
    ticket.status = target.name;
    markUpdated(ticket);
    return { status: 204 };
  }
  if (rest === "/assignee" && method === "PUT") {
    const { accountId } = body as { accountId: string | null };
    ticket.assignee = PEOPLE.find((p) => p.accountId === accountId) ?? null;
    markUpdated(ticket);
    return { status: 204 };
  }
  return { status: 404, json: { errorMessages: ["Not found"], errors: {} } };
}

export function startFakeJira(port: number): Promise<Server> {
  return startFakeServer("fake-jira", port, handleJiraRequest);
}
