import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * The guard and validation cases are rejected before any Azure or database
 * access, the same approach as the JIRA route tests. The upstream blocks stub
 * the global fetch the Azure client picks up, and the start-work block also
 * needs the test database.
 */
function appWith(overrides: {
  databaseUrl?: string;
  secrets?: Config["secrets"];
}): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: overrides.databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: overrides.secrets ?? {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const auth = { Authorization: "Bearer test-token" };
const json = { ...auth, "Content-Type": "application/json" };
const azureSecrets = {
  azureDevopsToken: "pat",
  azureDevopsOrgUrl: "https://dev.azure.com/acme",
};
const configured = appWith({ databaseUrl: "postgres://localhost/unused", secrets: azureSecrets });

describe("azure boards routes: auth + guards", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/azure-boards/assigned");
    expect(res.status).toBe(401);
  });

  it("503s when no database is configured", async () => {
    const app = appWith({ secrets: azureSecrets });
    const res = await app.request("/api/azure-boards/assigned", { headers: auth });
    expect(res.status).toBe(503);
  });

  it("400s with a reason when Azure DevOps is not configured", async () => {
    const app = appWith({ databaseUrl: "postgres://localhost/unused" });
    const res = await app.request("/api/azure-boards/assigned", { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "missing_token" });
  });

  it("400s a non-Azure org URL rather than sending the PAT", async () => {
    const app = appWith({
      databaseUrl: "postgres://localhost/unused",
      secrets: { ...azureSecrets, azureDevopsOrgUrl: "https://evil.example.com/acme" },
    });
    const res = await app.request("/api/azure-boards/assigned", { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid_org_url" });
  });
});

describe("azure boards routes: input validation", () => {
  it("400s a search with no query", async () => {
    const res = await configured.request("/api/azure-boards/search", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a non-numeric work item id", async () => {
    const res = await configured.request("/api/azure-boards/item/abc", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a non-numeric id in an item list", async () => {
    const res = await configured.request("/api/azure-boards/items?ids=1,x", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s an empty field update", async () => {
    const res = await configured.request("/api/azure-boards/item/7", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s a state change with no state", async () => {
    const res = await configured.request("/api/azure-boards/item/7/state", {
      method: "POST",
      headers: json,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s a tag containing the ; separator", async () => {
    const res = await configured.request("/api/azure-boards/item/7", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ tags: ["a;b"] }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work with a project name holding a newline", async () => {
    const res = await configured.request("/api/azure-boards/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "Web\nApp", externalId: "7", title: "t" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work with a project name that would traverse", async () => {
    const res = await configured.request("/api/azure-boards/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "../x", externalId: "7", title: "t" }),
    });
    expect(res.status).toBe(400);
  });
});

interface Recorded {
  method: string;
  url: string;
  body: unknown;
}

/**
 * Stubs the global fetch with a route table keyed by "METHOD path" (path after
 * the org URL, no query string). A `{ status }` value answers with that error.
 */
function stubAzure(routes: Record<string, unknown>): Recorded[] {
  const recorded: Recorded[] = [];
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const path = String(url).replace(azureSecrets.azureDevopsOrgUrl, "").split("?")[0] ?? "";
    recorded.push({
      method,
      url: String(url),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const value = routes[`${method} ${path}`];
    if (value === undefined) return new Response("not found", { status: 404 });
    if (value && typeof value === "object" && "status" in value) {
      return new Response(JSON.stringify({ message: "secret upstream detail" }), {
        status: (value as { status: number }).status,
      });
    }
    return new Response(JSON.stringify(value), { status: 200 });
  }) as typeof fetch;
  return recorded;
}

const itemFields = {
  "System.Title": "Fix the login bug",
  "System.State": "New",
  "System.WorkItemType": "Task",
  "System.TeamProject": "Web App",
};

// Enough for a detail load: the item, its comments and its type's states.
const detailRoutes = {
  "GET /_apis/wit/workitems/7": { id: 7, fields: itemFields },
  "GET /Web%20App/_apis/wit/workItems/7/comments": { comments: [] },
  "GET /Web%20App/_apis/wit/workitemtypes/Task/states": {
    value: [
      { name: "New", category: "Proposed" },
      { name: "Active", category: "InProgress" },
    ],
  },
};

describe("azure boards routes: upstream calls", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("502s with a generic message that leaves Azure's error out", async () => {
    stubAzure({ "GET /_apis/wit/workitems/7": { status: 500 } });
    const res = await configured.request("/api/azure-boards/item/7", { headers: auth });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "azure boards request failed" });
  });

  it("assigns to the viewer's unique name and returns the refreshed detail", async () => {
    const recorded = stubAzure({
      ...detailRoutes,
      "GET /_apis/connectionData": {
        authenticatedUser: {
          id: "u1",
          providerDisplayName: "Jane",
          properties: { Account: { $value: "jane@acme.com" } },
        },
      },
      "PATCH /_apis/wit/workitems/7": { id: 7 },
    });
    const res = await configured.request("/api/azure-boards/item/7/assignee", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ self: true }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ externalId: "7", bodyField: "description" });
    expect(recorded.find((r) => r.method === "PATCH")?.body).toEqual([
      { op: "add", path: "/fields/System.AssignedTo", value: "jane@acme.com" },
    ]);
  });

  it("unassigns with a remove op", async () => {
    const recorded = stubAzure({ ...detailRoutes, "PATCH /_apis/wit/workitems/7": { id: 7 } });
    const res = await configured.request("/api/azure-boards/item/7/assignee", {
      method: "PUT",
      headers: json,
      body: JSON.stringify({ self: false }),
    });
    expect(res.status).toBe(200);
    expect(recorded.find((r) => r.method === "PATCH")?.body).toEqual([
      { op: "remove", path: "/fields/System.AssignedTo" },
    ]);
  });

  it("sends `wiql` as a query and `text` as a title search", async () => {
    const recorded = stubAzure({ "POST /_apis/wit/wiql": { workItems: [] } });
    await configured.request(
      `/api/azure-boards/search?wiql=${encodeURIComponent("SELECT [System.Id] FROM WorkItems")}`,
      { headers: auth },
    );
    await configured.request("/api/azure-boards/search?text=login", { headers: auth });
    const queries = recorded.map((r) => (r.body as { query: string }).query);
    expect(queries[0]).toBe("SELECT [System.Id] FROM WorkItems");
    expect(queries[1]).toContain("[System.Title] CONTAINS 'login'");
  });

  it("answers an empty id list without calling Azure", async () => {
    const recorded = stubAzure({});
    const res = await configured.request("/api/azure-boards/items?ids=", { headers: auth });
    expect(await res.json()).toEqual([]);
    expect(recorded).toEqual([]);
  });
});

/**
 * Start work writes the workspace, its kick-off prompt and the issue link, so
 * it needs the real tables. Azure is stubbed through the global fetch.
 */
describe("azure boards routes: start work", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const dbApp = appWith({ databaseUrl: url, secrets: azureSecrets });
  const realFetch = globalThis.fetch;

  beforeEach(async () => {
    await sql`TRUNCATE repos, workspaces, workspace_repos, issue_links RESTART IDENTITY CASCADE`;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  afterAll(async () => {
    await sql.end();
  });

  const startWork = (body: Record<string, unknown>) =>
    dbApp.request("/api/azure-boards/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify(body),
    });

  it("links the work item, stores the prompt and moves it to its in-progress state", async () => {
    const recorded = stubAzure({
      ...detailRoutes,
      "PATCH /_apis/wit/workitems/7": { id: 7 },
    });
    const res = await startWork({
      sourceKey: "Web App",
      externalId: "7",
      title: "Fix the login bug",
      body: "It is broken.",
      assignSelf: false,
    });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { workspaceId: string; warnings: string[] };
    expect(created.warnings).toEqual([]);

    const [link] = await sql<{ provider: string; external_id: string; local_status: string }[]>`
      SELECT provider, external_id, local_status FROM issue_links
      WHERE workspace_id = ${created.workspaceId}`;
    expect(link).toEqual({ provider: "azure", external_id: "7", local_status: "in_progress" });

    const [ws] = await sql<{ pending_issue_prompt: string | null }[]>`
      SELECT pending_issue_prompt FROM workspaces WHERE id = ${created.workspaceId}`;
    expect(ws?.pending_issue_prompt).toContain("Implement the following Web App issue #7.");
    expect(ws?.pending_issue_prompt).toContain("It is broken.");

    expect(recorded.find((r) => r.method === "PATCH")?.body).toEqual([
      { op: "add", path: "/fields/System.State", value: "Active" },
    ]);
  });

  it("still starts work, with warnings, when Azure rejects the writes", async () => {
    stubAzure({ "GET /_apis/connectionData": { status: 401 } });
    const res = await startWork({ sourceKey: "Web App", externalId: "7", title: "Fix it" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { workspaceId: string; warnings: string[] };
    expect(created.warnings).toHaveLength(2);
    expect(created.warnings[0]).toContain("could not assign work item");
    expect(created.warnings[1]).toContain("could not change state");
  });
});
