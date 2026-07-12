import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/**
 * Config wired with a GitHub token + a database URL so the GitHub routes run
 * their request validation. The bad inputs below are all rejected before any
 * GitHub or database access, so no real services are needed.
 */
function appWith(secrets: Config["secrets"]): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: "postgres://localhost/unused",
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets,
    customProviderSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  });
}

const configured = appWith({ githubToken: "ghp_test" });
const auth = { Authorization: "Bearer test-token" };

describe("github review submission validation", () => {
  it("rejects REQUEST_CHANGES without a body with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "REQUEST_CHANGES" }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("request changes");
  });

  it("rejects REQUEST_CHANGES with a whitespace-only body with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "REQUEST_CHANGES", body: "   \n  " }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects an unknown event value with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "BURN_IT_DOWN" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric PR number with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/abc/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "APPROVE" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github viewed-files validation", () => {
  it("rejects an empty path with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/viewed", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "", viewed: true }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-boolean viewed flag with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/viewed", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "src/app.ts", viewed: "yes" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github merge validation", () => {
  it("rejects an unknown merge method with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/1/merge", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "FAST_FORWARD" }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a non-numeric PR number on auto-merge with 400", async () => {
    const res = await configured.request("/api/github/pr/octo/repo/abc/auto-merge", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ method: "SQUASH" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("github not-configured handling", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/github/viewer");
    expect(res.status).toBe(401);
  });

  it("returns 400 when no GitHub token is configured", async () => {
    const app = appWith({});
    const res = await app.request("/api/github/pr/octo/repo/1/reviews", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ event: "APPROVE" }),
    });
    expect(res.status).toBe(400);
  });
});
