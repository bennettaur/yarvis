import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * MCP route tests. Require a Postgres with pgvector (provided in CI). With no
 * embeddings_config row and no GEMINI key, the registry falls back to the
 * offline HashEmbedder, so these run without network access.
 */
const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const jsonAuth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

// The tool routes seed the built-in registry once per app and remember they did,
// so an app outliving the TRUNCATE below would serve an empty registry for every
// test after the first. Build a fresh one per test to keep the two in step.
let app: ReturnType<typeof createApp>;

beforeEach(async () => {
  await sql`TRUNCATE agent_tools, mcp_servers RESTART IDENTITY CASCADE`;
  app = createApp(config);
});

afterAll(async () => {
  await sql.end();
});

describe("mcp server routes", () => {
  it("creates, lists, patches, and deletes a server", async () => {
    const createRes = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "remote",
        transport: "http",
        url: "https://mcp.example.com/sse",
        headerNames: ["X-Tenant"],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("remote");

    const listRes = await app.request("/api/mcp/servers", { headers: jsonAuth });
    const rows = (await listRes.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(created.id);

    const patchRes = await app.request(`/api/mcp/servers/${created.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ enabled: false }),
    });
    expect(patchRes.status).toBe(200);
    expect(((await patchRes.json()) as { enabled: boolean }).enabled).toBe(false);

    const del = await app.request(`/api/mcp/servers/${created.id}`, {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect(del.status).toBe(204);
    const missing = await app.request(`/api/mcp/servers/${created.id}`, { headers: jsonAuth });
    expect(missing.status).toBe(404);
  });

  it("creates a stdio server with a command", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "fs",
        transport: "stdio",
        command: "npx",
        args: ["-y", "server"],
      }),
    });
    expect(res.status).toBe(201);
  });

  it("accepts the form's payload, which nulls the unused transport's field", async () => {
    // The Add-server form always sends both `url` and `command`, nulling
    // whichever the chosen transport doesn't use. Declaring them merely
    // optional rejected that null and made the form unable to create anything.
    const http = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "locker",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        command: null,
        args: [],
        headerNames: [],
        oauth: false,
        oauthScope: null,
      }),
    });
    expect(http.status).toBe(201);

    const stdio = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "fs",
        transport: "stdio",
        url: null,
        command: "npx",
        args: ["-y", "server"],
        headerNames: [],
        oauth: false,
        oauthScope: null,
      }),
    });
    expect(stdio.status).toBe(201);
  });

  it("rejects an http server without a url", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "bad", transport: "http" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a stdio server without a command", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "bad", transport: "stdio" }),
    });
    expect(res.status).toBe(400);
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/mcp/servers");
    expect(res.status).toBe(401);
  });

  it("returns 404 when refreshing an unknown server", async () => {
    const res = await app.request("/api/mcp/servers/00000000-0000-0000-0000-000000000000/refresh", {
      method: "POST",
      headers: jsonAuth,
    });
    expect(res.status).toBe(404);
  });
});

describe("mcp oauth routes", () => {
  const createOAuthServer = async (body: Record<string, unknown> = {}) =>
    app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "locker",
        transport: "http",
        url: "https://mcp.example.com/mcp",
        oauth: true,
        ...body,
      }),
    });

  it("stores the oauth flag and scope", async () => {
    const res = await createOAuthServer({ oauthScope: "api:read offline_access" });
    expect(res.status).toBe(201);
    const created = (await res.json()) as { oauth: boolean; oauthScope: string };
    expect(created.oauth).toBe(true);
    expect(created.oauthScope).toBe("api:read offline_access");
  });

  it("defaults oauth off so existing servers keep their bearer headers", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "plain",
        transport: "http",
        url: "https://mcp.example.com/mcp",
      }),
    });
    const created = (await res.json()) as { oauth: boolean; oauthScope: string | null };
    expect(created.oauth).toBe(false);
    expect(created.oauthScope).toBeNull();
  });

  it("rejects oauth on a stdio server", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "fs", transport: "stdio", command: "npx", oauth: true }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a scope string that isn't space-separated tokens", async () => {
    const res = await createOAuthServer({ oauthScope: 'api:read "injected"' });
    expect(res.status).toBe(400);
  });

  it("reports oauth status alongside the connection status", async () => {
    const created = (await (await createOAuthServer()).json()) as { id: string };
    const res = await app.request(`/api/mcp/servers/${created.id}/status`, { headers: jsonAuth });
    const status = (await res.json()) as { connected: boolean; oauth: unknown };
    expect(status.connected).toBe(false);
    expect(status.oauth).toEqual({ registered: false, authorized: false, scope: null });
  });

  it("reports no oauth status for a server that doesn't use it", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "plain",
        transport: "http",
        url: "https://mcp.example.com/mcp",
      }),
    });
    const created = (await res.json()) as { id: string };
    const status = (await (
      await app.request(`/api/mcp/servers/${created.id}/status`, { headers: jsonAuth })
    ).json()) as { oauth: unknown };
    expect(status.oauth).toBeNull();
  });

  it("refuses to authorize a server that doesn't use oauth", async () => {
    const res = await app.request("/api/mcp/servers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "plain",
        transport: "http",
        url: "https://mcp.example.com/mcp",
      }),
    });
    const created = (await res.json()) as { id: string };
    const authorize = await app.request(`/api/mcp/servers/${created.id}/authorize`, {
      method: "POST",
      headers: jsonAuth,
    });
    expect(authorize.status).toBe(404);
  });

  it("requires authentication to start a flow", async () => {
    const res = await app.request(
      "/api/mcp/servers/00000000-0000-0000-0000-000000000000/authorize",
      { method: "POST" },
    );
    expect(res.status).toBe(401);
  });
});

describe("mcp oauth callback", () => {
  it("is reachable without the bearer token", async () => {
    // The browser redirect can't carry it; the state nonce is the gate instead.
    const res = await app.request("/oauth/mcp/callback");
    expect(res.status).not.toBe(401);
  });

  it("refuses a callback whose state it never issued", async () => {
    const res = await app.request("/oauth/mcp/callback?code=abc&state=forged");
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("unknown or expired");
  });

  it("reports an authorization the user declined", async () => {
    const res = await app.request(
      "/oauth/mcp/callback?error=access_denied&error_description=User%20said%20no",
    );
    expect(res.status).toBe(400);
    expect(await res.text()).toContain("User said no");
  });

  it("refuses a callback with no code", async () => {
    const res = await app.request("/oauth/mcp/callback?state=abc");
    expect(res.status).toBe(400);
  });
});

describe("tool registry routes", () => {
  it("seeds built-in tools as 'always' and lists them", async () => {
    const res = await app.request("/api/mcp/tools", { headers: jsonAuth });
    expect(res.status).toBe(200);
    const tools = (await res.json()) as { id: string; source: string; policy: string }[];
    const createTask = tools.find((t) => t.id === "builtin:create_task");
    expect(createTask).toBeDefined();
    expect(createTask?.source).toBe("builtin");
    expect(createTask?.policy).toBe("always");
  });

  it("updates a tool's policy", async () => {
    await app.request("/api/mcp/tools", { headers: jsonAuth }); // seed builtins
    const patch = await app.request("/api/mcp/tools/builtin:create_task", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ policy: "search" }),
    });
    expect(patch.status).toBe(200);
    expect(((await patch.json()) as { policy: string }).policy).toBe("search");

    const list = await app.request("/api/mcp/tools", { headers: jsonAuth });
    const tools = (await list.json()) as { id: string; policy: string }[];
    expect(tools.find((t) => t.id === "builtin:create_task")?.policy).toBe("search");
  });

  it("rejects an unknown policy value", async () => {
    const res = await app.request("/api/mcp/tools/builtin:create_task", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ policy: "bogus" }),
    });
    expect(res.status).toBe(400);
  });

  it("searches only 'search'-policy tools", async () => {
    await app.request("/api/mcp/tools", { headers: jsonAuth }); // seed builtins

    const search = async (query: string) => {
      const res = await app.request("/api/mcp/tools/search", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ query }),
      });
      return ((await res.json()) as { id: string }[]).map((h) => h.id);
    };

    // `remember` seeds always-on, so it is in every turn already and has nothing
    // to be found by search.
    expect(await search("remember a fact")).not.toContain("builtin:remember");
    // A situational family seeds behind search, which is how the agent reaches it.
    expect(await search("start a claude session in a workspace")).toContain(
      "builtin:create_workspace_session",
    );

    await app.request("/api/mcp/tools/builtin:remember", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ policy: "search" }),
    });
    expect(await search("remember a fact")).toContain("builtin:remember");
  });
});
