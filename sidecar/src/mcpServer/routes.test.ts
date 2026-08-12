import { describe, expect, it } from "bun:test";
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

function post(body: unknown, token = "test-mcp-token"): RequestInit {
  return {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify(body),
  };
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
    const res = await app.request("/api/mcp-server/connection", {
      headers: { Authorization: "Bearer test-token" },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      url: "http://127.0.0.1:8765/mcp",
      token: "test-mcp-token",
    });
  });
});
