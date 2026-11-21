import { describe, expect, it } from "bun:test";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

// A config with the calendar integration "configured" (client id/secret present)
// and a database URL set so the route runs its request validation. The bad
// inputs below are rejected before any database access, so no real DB is needed.
const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: "postgres://localhost/unused",
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: { googleClientId: "cid", googleClientSecret: "secret" },
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };

describe("the Google redirect", () => {
  it("is the loopback callback, for a Desktop app client", async () => {
    const res = await app.request("/api/calendar/auth-url", { headers: auth });
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:0/oauth/google/callback");
  });

  it("is the server's origin when it is reached from other machines, for a Web client", async () => {
    const remote = createApp({ ...config, publicOrigin: "https://mini.example.ts.net" });
    const res = await remote.request("/api/calendar/auth-url", { headers: auth });
    const url = new URL(((await res.json()) as { url: string }).url);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "https://mini.example.ts.net/api/oauth/google/callback",
    );
  });
});

describe("calendar events route validation", () => {
  it("rejects a non-ISO timeMin with 400", async () => {
    const res = await app.request("/api/calendar/events?timeMin=not-a-date", {
      headers: auth,
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("ISO");
  });

  it("rejects a non-ISO timeMax with 400", async () => {
    const res = await app.request("/api/calendar/events?timeMax=garbage", {
      headers: auth,
    });
    expect(res.status).toBe(400);
  });

  it("requires the bearer token", async () => {
    const res = await app.request("/api/calendar/events");
    expect(res.status).toBe(401);
  });
});
