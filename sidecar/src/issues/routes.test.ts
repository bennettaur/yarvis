import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * Every case below is rejected by the provider guard, the db/token guards, or
 * Zod validation *before* any GitHub or database access, so no real services
 * are needed — the same approach as the PR routes test.
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
    allowedOrigins: null,
    databaseUrl: overrides.databaseUrl,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: overrides.secrets ?? {},
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const auth = { Authorization: "Bearer test-token" };
const json = { ...auth, "Content-Type": "application/json" };
// db configured (so the db guard passes) + a token (so the token guard passes).
const configured = appWith({
  databaseUrl: "postgres://localhost/unused",
  secrets: { githubToken: "ghp_test" },
});

describe("issue routes: auth + guards", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/issues/github/repos");
    expect(res.status).toBe(401);
  });

  it("404s an unsupported provider", async () => {
    const res = await configured.request("/api/issues/linear/repos", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("404s a GitHub-only route for JIRA (JIRA serves these under /api/jira)", async () => {
    // JIRA is a supported provider for the DB-backed routes (stars/filters/
    // links), but the GitHub-shaped live routes stay GitHub-only.
    const res = await configured.request("/api/issues/jira/repos", { headers: auth });
    expect(res.status).toBe(404);
  });

  it("503s when no database is configured", async () => {
    const app = appWith({ secrets: { githubToken: "ghp_test" } });
    const res = await app.request("/api/issues/github/repos", { headers: auth });
    expect(res.status).toBe(503);
  });

  it("400s live queries when no GitHub token is configured", async () => {
    const app = appWith({ databaseUrl: "postgres://localhost/unused" });
    const res = await app.request("/api/issues/github/assigned", { headers: auth });
    expect(res.status).toBe(400);
  });
});

describe("issue routes: input validation", () => {
  it("400s search without a query", async () => {
    const res = await configured.request("/api/issues/github/search", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("400s a detail request with an invalid owner (path-injection guard)", async () => {
    const res = await configured.request("/api/issues/github/detail/bad..owner/repo/1", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("400s a detail request with a non-numeric issue id", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/abc", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("400s creating an issue without a title", async () => {
    const res = await configured.request("/api/issues/github/create/octo/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ body: "no title" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s creating an issue in a repo whose owner is invalid", async () => {
    const res = await configured.request("/api/issues/github/create/bad..owner/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("404s creating an issue for a non-GitHub provider", async () => {
    const res = await configured.request("/api/issues/jira/create/octo/repo", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ title: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("400s an update that carries no fields", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("400s an update with an unknown state", async () => {
    const res = await configured.request("/api/issues/github/detail/octo/repo/1", {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ state: "merged" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work on a schema failure (missing title)", async () => {
    const res = await configured.request("/api/issues/github/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "octo/repo", externalId: "1" }),
    });
    expect(res.status).toBe(400);
  });

  it("400s start-work on a non-integer issue id", async () => {
    const res = await configured.request("/api/issues/github/start-work", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ sourceKey: "octo/repo", externalId: "abc", title: "x" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("bad issue id");
  });
});
