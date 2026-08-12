import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

function testConfig(overrides: Partial<Config> = {}): Config {
  return {
    port: 8765,
    token: "test-token",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: "postgres://localhost:5432/yarvis_test",
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: {},
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
    ...overrides,
  };
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "test-client", version: "0.0.0" },
  },
};

/** Host a real client presents when it dials the loopback endpoint. */
const HOST = "127.0.0.1:8765";

function post(body: unknown, token = "test-mcp-token", host = HOST): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Host: host,
    },
    body: JSON.stringify(body),
  };
}

/** Runs the handshake and returns the session's POST helper. */
async function handshake(app: ReturnType<typeof createApp>) {
  const res = await app.request("/mcp", post(INITIALIZE));
  expect(res.status).toBe(200);
  const initialized = await app.request(
    "/mcp",
    post({ jsonrpc: "2.0", method: "notifications/initialized" }),
  );
  expect(initialized.status).toBe(202);
}

describe("mcp endpoint", () => {
  it("rejects a request without the scoped mcp token", async () => {
    const app = createApp(testConfig());
    expect((await app.request("/mcp", { method: "POST" })).status).toBe(401);
    expect((await app.request("/mcp", post(INITIALIZE, "wrong"))).status).toBe(401);
  });

  it("does not accept the full-access bearer token", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/mcp", post(INITIALIZE, "test-token"));
    expect(res.status).toBe(401);
  });

  it("completes the MCP handshake for a client holding the scoped token", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/mcp", post(INITIALIZE));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { serverInfo: { name: string }; capabilities: { tools?: unknown } };
    };
    expect(body.result.serverInfo.name).toBe("yarvis");
    expect(body.result.capabilities.tools).toBeDefined();
  });

  it("serves tools on a later request, with no session carried from the handshake", async () => {
    // Each request builds its own server, so a fresh one must answer tools/list
    // without having seen the initialize that preceded it.
    const app = createApp(testConfig());
    await handshake(app);

    const res = await app.request(
      "/mcp",
      post({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(body.result.tools.map((t) => t.name).sort()).toEqual([
      "forget",
      "list_memories",
      "recall",
      "remember",
      "take_note",
    ]);
  });

  it("refuses a request addressed to a host that is not ours", async () => {
    // A page can point a name it controls at 127.0.0.1; the Host header is what
    // separates that from a client that dialed us directly.
    const app = createApp(testConfig());
    const res = await app.request("/mcp", post(INITIALIZE, "test-mcp-token", "evil.example.com"));
    expect(res.status).toBe(403);
  });

  it("answers 503 while no database is configured", async () => {
    const app = createApp(testConfig({ databaseUrl: undefined }));
    const res = await app.request("/mcp", post(INITIALIZE));
    expect(res.status).toBe(503);
  });

  it("declines GET and DELETE — the endpoint is POST-only", async () => {
    const app = createApp(testConfig());
    const auth = { Authorization: "Bearer test-mcp-token" };
    expect((await app.request("/mcp", { method: "GET", headers: auth })).status).toBe(405);
    expect((await app.request("/mcp", { method: "DELETE", headers: auth })).status).toBe(405);
  });

  it("hands the frontend the endpoint and token for outside clients", async () => {
    const app = createApp(testConfig());
    const res = await app.request("/api/mcp-endpoint/connection", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "http://127.0.0.1:8765/mcp",
      token: "test-mcp-token",
    });
  });
});

/**
 * The tools over the real store, through the HTTP endpoint — the seam neither
 * `server.test.ts` (fake store, in-memory transport) nor the cases above (which
 * stop at the handshake) covers. Needs the same Postgres the other storage
 * tests use.
 */
describe("mcp endpoint over a real store", () => {
  const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
  const sql = postgres(url, { max: 1 });
  const app = createApp(testConfig({ databaseUrl: url }));

  beforeEach(async () => {
    // embeddings_config too: another file can leave a wrong-dimension row behind,
    // which would make chooseEmbedder pick it and fail every tool call here.
    await sql`TRUNCATE memories, embeddings_config RESTART IDENTITY CASCADE`;
  });

  afterAll(async () => {
    await sql.end();
  });

  const callTool = async (id: number, name: string, args: Record<string, unknown>) => {
    const res = await app.request(
      "/mcp",
      post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      result: { isError?: boolean; content: { text: string }[] };
    };
    expect(body.result.isError).toBeFalsy();
    return JSON.parse(body.result.content[0]?.text ?? "{}") as Record<string, unknown>;
  };

  it("stores a memory and recalls it back", async () => {
    await handshake(app);

    const stored = await callTool(2, "remember", { content: "Mike takes his coffee black" });
    expect(typeof stored.id).toBe("string");

    const recalled = await callTool(3, "recall", { query: "how does Mike take his coffee" });
    const results = recalled.results as { id: string; content: string }[];
    expect(results.length).toBeGreaterThan(0);
    expect(results.some((r) => r.content.includes("Mike takes his coffee black"))).toBe(true);

    const forgotten = await callTool(4, "forget", { id: String(stored.id) });
    expect(forgotten).toEqual({ deleted: true });

    const listed = await callTool(5, "list_memories", {});
    expect(listed.memories).toEqual([]);
  });
});
