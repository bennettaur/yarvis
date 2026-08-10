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
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const jsonAuth = { Authorization: "Bearer test-token", "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE agent_tools, mcp_servers RESTART IDENTITY CASCADE`;
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
    await app.request("/api/mcp/tools", { headers: jsonAuth }); // seed builtins (all 'always')
    // No tools are searchable yet.
    const empty = await app.request("/api/mcp/tools/search", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ query: "remember a fact" }),
    });
    expect(((await empty.json()) as unknown[]).length).toBe(0);

    await app.request("/api/mcp/tools/builtin:remember", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ policy: "search" }),
    });
    const hit = await app.request("/api/mcp/tools/search", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ query: "remember a fact" }),
    });
    const hits = (await hit.json()) as { id: string }[];
    expect(hits.map((h) => h.id)).toContain("builtin:remember");
  });
});
