import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const jsonAuth = {
  Authorization: "Bearer test-token",
  "Content-Type": "application/json",
};

beforeEach(async () => {
  await sql`TRUNCATE events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("event routes", () => {
  it("records a UI event and lists it", async () => {
    const post = await app.request("/api/events", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        type: "pr.viewed",
        source: "github",
        payload: { owner: "a", repo: "b", number: 7 },
      }),
    });
    expect(post.status).toBe(201);

    const list = await app.request("/api/events", { headers: jsonAuth });
    expect(list.status).toBe(200);
    const rows = (await list.json()) as { type: string }[];
    expect(rows.map((r) => r.type)).toContain("pr.viewed");
  });

  it("rejects an unknown event type", async () => {
    const res = await app.request("/api/events", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ type: "ui.clicked", payload: {} }),
    });
    expect(res.status).toBe(400);
  });

  it("filters list by type", async () => {
    for (const type of ["pr.viewed", "alarm.created"]) {
      await app.request("/api/events", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ type }),
      });
    }
    const res = await app.request("/api/events?type=alarm.created", {
      headers: jsonAuth,
    });
    const rows = (await res.json()) as { type: string }[];
    expect(rows.length).toBe(1);
    expect(rows[0]!.type).toBe("alarm.created");
  });

  it("rejects an unknown type filter", async () => {
    const res = await app.request("/api/events?type=bogus", {
      headers: jsonAuth,
    });
    expect(res.status).toBe(400);
  });

  it("tolerates a bad limit by falling back to the default", async () => {
    await app.request("/api/events", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ type: "pr.viewed" }),
    });
    // Negative/non-numeric limits must not error or reach the DB as-is.
    for (const limit of ["-5", "0", "abc"]) {
      const res = await app.request(`/api/events?limit=${limit}`, {
        headers: jsonAuth,
      });
      expect(res.status).toBe(200);
      expect(((await res.json()) as unknown[]).length).toBe(1);
    }
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(401);
  });
});
