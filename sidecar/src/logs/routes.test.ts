import { beforeEach, describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { clearLogs, record } from "../lib/log.ts";

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  // Deliberately absent: reading the log is how you diagnose a sidecar that
  // could not reach its database, so it must not need one.
  databaseUrl: undefined,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };

beforeEach(() => {
  clearLogs();
});

describe("GET /api/logs", () => {
  it("returns the tail and the scopes seen, without a database", async () => {
    record("error", ["[chat] model error: nope"]);
    record("debug", ["[mcp] connected"]);

    const res = await app.request("/api/logs", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries: { message: string }[]; scopes: string[] };
    expect(body.entries.map((e) => e.message)).toEqual(["model error: nope", "connected"]);
    expect(body.scopes).toEqual(["chat", "mcp"]);
  });

  it("applies the level filter", async () => {
    record("debug", ["[chat] noisy"]);
    record("error", ["[chat] broken"]);

    const res = await app.request("/api/logs?minLevel=warn", { headers: auth });
    const body = (await res.json()) as { entries: { message: string }[]; scopes: string[] };
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].message).toBe("broken");
  });

  it("rejects an unknown level rather than silently ignoring it", async () => {
    const res = await app.request("/api/logs?minLevel=loud", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("needs the bearer token", async () => {
    expect((await app.request("/api/logs")).status).toBe(401);
  });
});
