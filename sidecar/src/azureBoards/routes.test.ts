import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * Every case here is rejected by the auth guard, the database guard, the
 * Azure-config gate, or Zod validation before any Azure or database access, so
 * no real services are needed (the same approach as the JIRA route tests).
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

  it("400s start-work with a project name that would traverse", async () => {
    const res = await configured.request("/api/azure-boards/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "../x", externalId: "7", title: "t" }),
    });
    expect(res.status).toBe(400);
  });
});
