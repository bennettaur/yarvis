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
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {},
  customProviderSecrets: {},
  mcpSecrets: {},
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
    const page = (await list.json()) as { items: { type: string }[]; total: number };
    expect(page.items.map((r) => r.type)).toContain("pr.viewed");
    expect(page.total).toBe(1);
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
    const page = (await res.json()) as { items: { type: string }[]; total: number };
    expect(page.total).toBe(1);
    expect(page.items[0]!.type).toBe("alarm.created");
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
      expect(((await res.json()) as { items: unknown[] }).items.length).toBe(1);
    }
  });

  it("paginates with a stable total and searches the payload", async () => {
    for (const number of [1, 2, 3]) {
      await app.request("/api/events", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({
          type: "pr.viewed",
          source: "github",
          payload: { owner: "a", repo: "b", number, title: number === 2 ? "Fix flaky login" : "x" },
        }),
      });
    }

    const firstPage = await app.request("/api/events?limit=2&offset=0", { headers: jsonAuth });
    const first = (await firstPage.json()) as { items: unknown[]; total: number };
    expect(first.items.length).toBe(2);
    expect(first.total).toBe(3);

    const secondPage = await app.request("/api/events?limit=2&offset=2", { headers: jsonAuth });
    const second = (await secondPage.json()) as { items: unknown[]; total: number };
    expect(second.items.length).toBe(1);
    expect(second.total).toBe(3);

    const search = await app.request("/api/events?q=flaky%20login", { headers: jsonAuth });
    const found = (await search.json()) as {
      items: { payload: { number: number } }[];
      total: number;
    };
    expect(found.total).toBe(1);
    expect(found.items[0]!.payload.number).toBe(2);
  });

  it("lists the known event types", async () => {
    const res = await app.request("/api/events/types", { headers: jsonAuth });
    const body = (await res.json()) as { types: string[] };
    expect(body.types).toContain("pr.approved");
    expect(body.types).toContain("workspace.archived");
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/events");
    expect(res.status).toBe(401);
  });
});
