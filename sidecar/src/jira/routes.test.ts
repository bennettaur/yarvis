import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * These cases are all rejected by the auth guard, the db guard, the JIRA-config
 * gate, or Zod validation *before* any JIRA or database access, so no real
 * services are needed — the same approach as the issue/PR route tests.
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
const jiraSecrets = {
  jiraBaseUrl: "https://acme.atlassian.net",
  jiraEmail: "me@acme.com",
  jiraApiToken: "token",
};
const configured = appWith({ databaseUrl: "postgres://localhost/unused", secrets: jiraSecrets });

describe("jira routes: auth + guards", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/jira/assigned");
    expect(res.status).toBe(401);
  });

  it("503s when no database is configured", async () => {
    const app = appWith({ secrets: jiraSecrets });
    const res = await app.request("/api/jira/assigned", { headers: auth });
    expect(res.status).toBe(503);
  });

  it("400s with a reason when JIRA is not configured", async () => {
    const app = appWith({ databaseUrl: "postgres://localhost/unused" });
    const res = await app.request("/api/jira/assigned", { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "missing_base_url" });
  });

  it("400s an invalid (non-atlassian) base URL rather than sending the token", async () => {
    const app = appWith({
      databaseUrl: "postgres://localhost/unused",
      secrets: { ...jiraSecrets, jiraBaseUrl: "https://evil.example.com" },
    });
    const res = await app.request("/api/jira/assigned", { headers: auth });
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ reason: "invalid_base_url" });
  });
});

describe("jira routes: input validation", () => {
  it("400s search without a jql query", async () => {
    const res = await configured.request("/api/jira/search", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a detail request with a malformed issue key", async () => {
    const res = await configured.request("/api/jira/issue/notakey", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a transition with no body", async () => {
    const res = await configured.request("/api/jira/issue/PROJ-1/transition", {
      method: "POST",
      headers: json,
    });
    expect(res.status).toBe(400);
  });

  it("400s create-issue with a missing summary", async () => {
    const res = await configured.request("/api/jira/issues", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ projectKey: "PROJ", issueTypeName: "Task" }),
    });
    expect(res.status).toBe(400);
  });
});
