import { describe, expect, it } from "bun:test";
import { isAllowedJiraBaseUrl, JiraClient } from "./client.ts";

const BASE = "https://acme.atlassian.net";

interface RecordedRequest {
  method: string;
  path: string;
  body: unknown;
}

/**
 * Fake fetch matching request paths (after the `/rest/api/3` prefix) against a
 * route table, recording each call so mutation payloads can be asserted. A route
 * value is the JSON body to return (200), or a `{ status }` for empty responses.
 */
function fakeFetch(routes: Record<string, unknown>, recorder?: RecordedRequest[]): typeof fetch {
  return (async (url: string, init?: RequestInit) => {
    const path = String(url).replace(`${BASE}/rest/api/3`, "");
    recorder?.push({
      method: init?.method ?? "GET",
      path,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const key = Object.keys(routes).find((k) => path.startsWith(k));
    if (!key) return new Response("not found", { status: 404 });
    const value = routes[key];
    if (value && typeof value === "object" && "status" in (value as object)) {
      return new Response(null, { status: (value as { status: number }).status });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  }) as unknown as typeof fetch;
}

const client = (routes: Record<string, unknown>, recorder?: RecordedRequest[]) =>
  new JiraClient(BASE, "me@acme.com", "token", fakeFetch(routes, recorder));

function issueFields(overrides: Record<string, unknown> = {}) {
  return {
    summary: "Fix the login bug",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    labels: ["backend", "urgent"],
    assignee: { displayName: "Jane Dev", accountId: "acc-1" },
    reporter: { displayName: "Sam Report" },
    issuetype: { name: "Bug" },
    priority: { name: "High" },
    created: "2026-01-01T00:00:00.000Z",
    updated: "2026-01-02T00:00:00.000Z",
    project: { key: "PROJ", name: "My Project" },
    ...overrides,
  };
}

describe("isAllowedJiraBaseUrl", () => {
  it("accepts https atlassian.net sites", () => {
    expect(isAllowedJiraBaseUrl("https://acme.atlassian.net")).toBe(true);
  });
  it("rejects http and non-atlassian hosts", () => {
    expect(isAllowedJiraBaseUrl("http://acme.atlassian.net")).toBe(false);
    expect(isAllowedJiraBaseUrl("https://evil.example.com")).toBe(false);
    expect(isAllowedJiraBaseUrl("not a url")).toBe(false);
    // A lookalike host that merely contains the suffix mid-string is rejected.
    expect(isAllowedJiraBaseUrl("https://atlassian.net.evil.com")).toBe(false);
  });
});

describe("JiraClient shaping", () => {
  it("shapes a search hit into a provider-neutral summary", async () => {
    const jira = client({
      "/search/jql": { issues: [{ key: "PROJ-45", fields: issueFields() }] },
    });
    const [issue] = await jira.searchIssues("assignee = currentUser()");
    expect(issue).toMatchObject({
      provider: "jira",
      sourceKey: "PROJ",
      sourceLabel: "My Project",
      externalId: "PROJ-45",
      displayId: "PROJ-45",
      title: "Fix the login bug",
      url: "https://acme.atlassian.net/browse/PROJ-45",
      state: "open",
      author: "Sam Report",
      assignees: ["Jane Dev"],
      statusName: "In Progress",
      statusCategory: "in_progress",
      issueType: "Bug",
    });
    expect(issue!.labels).toEqual([
      { name: "backend", color: null },
      { name: "urgent", color: null },
    ]);
  });

  it("maps a done status category to closed state", async () => {
    const jira = client({
      "/search/jql": {
        issues: [
          {
            key: "PROJ-9",
            fields: issueFields({
              status: { name: "Done", statusCategory: { key: "done" } },
            }),
          },
        ],
      },
    });
    const [issue] = await jira.searchIssues("x");
    expect(issue).toMatchObject({ state: "closed", statusCategory: "done" });
  });

  it("assembles full detail with comments, linked issues, and transitions", async () => {
    const jira = client({
      "/issue/PROJ-45?fields": {
        key: "PROJ-45",
        fields: issueFields({
          description: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Details here" }] }],
          },
          issuelinks: [
            {
              type: { inward: "is blocked by", outward: "blocks" },
              inwardIssue: {
                key: "PROJ-10",
                fields: {
                  summary: "Blocker",
                  status: { name: "To Do", statusCategory: { key: "new" } },
                  issuetype: { name: "Task" },
                },
              },
            },
          ],
        }),
      },
      "/issue/PROJ-45/comment": {
        comments: [
          {
            author: { displayName: "Sam" },
            body: {
              type: "doc",
              content: [{ type: "paragraph", content: [{ type: "text", text: "a note" }] }],
            },
            created: "2026-01-03T00:00:00.000Z",
          },
        ],
      },
      "/issue/PROJ-45/transitions": {
        transitions: [
          { id: "31", name: "Done", to: { name: "Done", statusCategory: { key: "done" } } },
        ],
      },
    });
    const detail = await jira.issueDetail("PROJ-45");
    expect(detail.body).toBe("Details here");
    expect(detail.reporter).toBe("Sam Report");
    expect(detail.assignee).toBe("Jane Dev");
    expect(detail.assigneeAccountId).toBe("acc-1");
    expect(detail.priority).toBe("High");
    expect(detail.commentCount).toBe(1);
    expect(detail.comments).toEqual([
      { author: "Sam", body: "a note", createdAt: "2026-01-03T00:00:00.000Z" },
    ]);
    expect(detail.linkedIssues).toEqual([
      {
        key: "PROJ-10",
        summary: "Blocker",
        statusName: "To Do",
        statusCategory: "todo",
        linkType: "is blocked by",
        issueType: "Task",
        url: "https://acme.atlassian.net/browse/PROJ-10",
      },
    ]);
    expect(detail.transitions).toEqual([
      { id: "31", name: "Done", toStatusName: "Done", toStatusCategory: "done" },
    ]);
  });

  it("derives the project key from the issue key when the project field is absent", async () => {
    const jira = client({
      "/search/jql": {
        issues: [{ key: "ABC-7", fields: issueFields({ project: undefined }) }],
      },
    });
    const [issue] = await jira.searchIssues("x");
    expect(issue).toMatchObject({ sourceKey: "ABC", sourceLabel: "ABC" });
  });
});

describe("JiraClient mutations", () => {
  it("PUTs the assignee account id", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client({ "/issue/PROJ-1/assignee": { status: 204 } }, calls);
    await jira.assign("PROJ-1", "acc-9");
    expect(calls[0]).toEqual({
      method: "PUT",
      path: "/issue/PROJ-1/assignee",
      body: { accountId: "acc-9" },
    });
  });

  it("unassigns with a null account id", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client({ "/issue/PROJ-1/assignee": { status: 204 } }, calls);
    await jira.assign("PROJ-1", null);
    expect(calls[0]?.body).toEqual({ accountId: null });
  });

  it("POSTs a transition by id", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client({ "/issue/PROJ-1/transitions": { status: 204 } }, calls);
    await jira.transitionIssue("PROJ-1", "31");
    expect(calls[0]).toMatchObject({
      method: "POST",
      body: { transition: { id: "31" } },
    });
  });

  it("only sends provided fields on update, converting description to ADF", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client({ "/issue/PROJ-1": { status: 204 } }, calls);
    await jira.updateFields("PROJ-1", { summary: "New title", labels: ["a", "b"] });
    expect(calls[0]?.method).toBe("PUT");
    expect(calls[0]?.body).toEqual({ fields: { summary: "New title", labels: ["a", "b"] } });

    calls.length = 0;
    await jira.updateFields("PROJ-1", { description: "Hello" });
    const body = calls[0]?.body as { fields: { description: unknown } };
    expect(body.fields.description).toEqual({
      version: 1,
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
    });
  });

  it("posts a comment as ADF and shapes the response", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client(
      {
        "/issue/PROJ-1/comment": {
          author: { displayName: "Me" },
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
          },
          created: "2026-01-05T00:00:00.000Z",
        },
      },
      calls,
    );
    const comment = await jira.addComment("PROJ-1", "hi");
    expect((calls[0]?.body as { body: unknown }).body).toEqual({
      version: 1,
      type: "doc",
      content: [{ type: "paragraph", content: [{ type: "text", text: "hi" }] }],
    });
    expect(comment).toEqual({ author: "Me", body: "hi", createdAt: "2026-01-05T00:00:00.000Z" });
  });

  it("surfaces JIRA error messages on a failed request", async () => {
    const failing = (async () =>
      new Response(JSON.stringify({ errorMessages: ["Field 'summary' is required"] }), {
        status: 400,
      })) as unknown as typeof fetch;
    const jira = new JiraClient(BASE, "me@acme.com", "token", failing);
    await expect(jira.updateFields("PROJ-1", { summary: "x" })).rejects.toThrow(
      "Field 'summary' is required",
    );
  });

  it("sends no request when updateFields is given no fields", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client({}, calls);
    await jira.updateFields("PROJ-1", {});
    expect(calls).toHaveLength(0);
  });

  it("creates an issue then fetches its summary (two-step)", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client(
      {
        // More specific key first so the GET summary matches before the POST key.
        "/issue/PROJ-5": { key: "PROJ-5", fields: issueFields() },
        "/issue": { key: "PROJ-5" },
      },
      calls,
    );
    const created = await jira.createIssue({
      projectKey: "PROJ",
      summary: "New one",
      issueTypeName: "Task",
      description: "hi",
    });
    expect(calls[0]?.method).toBe("POST");
    const body = calls[0]?.body as { fields: Record<string, unknown> };
    expect(body.fields.project).toEqual({ key: "PROJ" });
    expect(body.fields.issuetype).toEqual({ name: "Task" });
    expect(body.fields.description).toBeDefined(); // ADF attached when described
    expect(created).toMatchObject({ externalId: "PROJ-5", provider: "jira" });
  });

  it("omits the description field when none is provided", async () => {
    const calls: RecordedRequest[] = [];
    const jira = client(
      { "/issue/PROJ-6": { key: "PROJ-6", fields: issueFields() }, "/issue": { key: "PROJ-6" } },
      calls,
    );
    await jira.createIssue({ projectKey: "PROJ", summary: "No desc", issueTypeName: "Task" });
    const body = calls[0]?.body as { fields: Record<string, unknown> };
    expect(body.fields.description).toBeUndefined();
  });

  it("shapes an outward linked issue using the outward relationship label", async () => {
    const jira = client({
      "/issue/PROJ-1?fields": {
        key: "PROJ-1",
        fields: issueFields({
          issuelinks: [
            {
              type: { inward: "is blocked by", outward: "blocks" },
              outwardIssue: {
                key: "PROJ-2",
                fields: {
                  summary: "Downstream",
                  status: { name: "Done", statusCategory: { key: "done" } },
                },
              },
            },
          ],
        }),
      },
      "/issue/PROJ-1/comment": { comments: [] },
      "/issue/PROJ-1/transitions": { transitions: [] },
    });
    const detail = await jira.issueDetail("PROJ-1");
    expect(detail.linkedIssues[0]).toMatchObject({
      key: "PROJ-2",
      linkType: "blocks",
      statusCategory: "done",
    });
  });
});
