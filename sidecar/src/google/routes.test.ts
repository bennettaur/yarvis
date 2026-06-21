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
  allowedOrigins: null,
  databaseUrl: "postgres://localhost/unused",
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: { googleClientId: "cid", googleClientSecret: "secret" },
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };

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
