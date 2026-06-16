import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

// Azure "configured" (token + a valid org URL) with a database URL set so the
// routes run their request validation. The bad inputs below are all rejected
// before any Azure or database access, so no real services are needed.
function appWith(secrets: Config["secrets"]): ReturnType<typeof createApp> {
  return createApp({
    port: 0,
    token: "test-token",
    tokenGenerated: false,
    allowedOrigins: null,
    databaseUrl: "postgres://localhost/unused",
    secrets,
    customProviderSecrets: {},
  });
}

const configured = appWith({
  azureDevopsToken: "pat",
  azureDevopsOrgUrl: "https://dev.azure.com/acme",
});
const auth = { Authorization: "Bearer test-token" };

describe("azure route validation", () => {
  it("rejects a non-numeric pull request id with 400", async () => {
    const res = await configured.request("/api/azure/pr/Shop/web/abc/detail", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("rejects a pull request id below 1 with 400", async () => {
    const res = await configured.request("/api/azure/pr/Shop/web/0/detail", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("rejects a project or repo segment containing traversal with 400", async () => {
    const res = await configured.request("/api/azure/pr/Shop/we..b/1/detail", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("rejects a file path with a traversal segment with 400", async () => {
    const res = await configured.request(
      `/api/azure/pr/Shop/web/1/file?path=${encodeURIComponent("../../etc/passwd")}`,
      { headers: auth },
    );
    expect(res.status).toBe(400);
  });

  it("rejects a comment with a line below 1 with 400", async () => {
    const res = await configured.request("/api/azure/pr/Shop/web/1/comments", {
      method: "POST",
      headers: { ...auth, "Content-Type": "application/json" },
      body: JSON.stringify({ path: "src/app.ts", line: 0, body: "hi" }),
    });
    expect(res.status).toBe(400);
  });
});

describe("azure not-configured handling", () => {
  it("requires the bearer token", async () => {
    const res = await configured.request("/api/azure/viewer");
    expect(res.status).toBe(401);
  });

  it("reports a missing token with reason missing_token", async () => {
    const app = appWith({
      azureDevopsToken: undefined,
      azureDevopsOrgUrl: "https://dev.azure.com/acme",
    });
    const res = await app.request("/api/azure/viewer", { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("missing_token");
  });

  it("reports a missing org URL with reason missing_org_url", async () => {
    const app = appWith({ azureDevopsToken: "pat", azureDevopsOrgUrl: undefined });
    const res = await app.request("/api/azure/viewer", { headers: auth });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { reason: string }).reason).toBe("missing_org_url");
  });

  it("treats a non-https / non-Azure org URL as an invalid org URL", async () => {
    const app = appWith({ azureDevopsToken: "pat", azureDevopsOrgUrl: "http://evil.example.com" });
    const res = await app.request("/api/azure/viewer", { headers: auth });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; reason: string };
    expect(body.error).toContain("not configured");
    expect(body.reason).toBe("invalid_org_url");
  });
});
