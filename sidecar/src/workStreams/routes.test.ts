import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { createWorkStreamRoutes } from "./routes.ts";
import { createStream } from "./service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const db = drizzle(sql, { schema });

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
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE work_streams, work_stream_links, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("/api/work-streams", () => {
  it("lists open streams and lets the user close one", async () => {
    const stream = await createStream(db, { title: "ship billing" });

    const listed = (await (await app.request("/api/work-streams", { headers: auth })).json()) as {
      id: string;
    }[];
    expect(listed.map((s) => s.id)).toEqual([stream.id]);

    const res = await app.request(`/api/work-streams/${stream.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ status: "dropped" }),
    });
    expect(res.status).toBe(200);
    expect(await (await app.request("/api/work-streams", { headers: auth })).json()).toEqual([]);
  });

  it("reads one stream, and lists closed ones when asked", async () => {
    const stream = await createStream(db, { title: "old work", status: "done" });

    const one = await app.request(`/api/work-streams/${stream.id}`, { headers: auth });
    expect(((await one.json()) as { links: unknown[] }).links).toEqual([]);
    const closed = (await (
      await app.request("/api/work-streams?status=done", { headers: auth })
    ).json()) as { id: string }[];
    expect(closed.map((s) => s.id)).toEqual([stream.id]);
  });

  it("answers 404 for a stream that doesn't exist, and 400 for a bad patch", async () => {
    const missing = "00000000-0000-4000-8000-000000000000";
    expect((await app.request(`/api/work-streams/${missing}`, { headers: auth })).status).toBe(404);
    const stream = await createStream(db, { title: "ship billing" });
    const res = await app.request(`/api/work-streams/${stream.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ status: "paused" }),
    });
    expect(res.status).toBe(400);
  });

  it("pauses and resumes a stream, keeping its status", async () => {
    const stream = await createStream(db, { title: "ship billing", status: "waiting-on-others" });
    const patch = (body: unknown) =>
      app.request(`/api/work-streams/${stream.id}`, {
        method: "PATCH",
        headers: jsonAuth,
        body: JSON.stringify(body),
      });

    expect((await patch({ paused: "yes" })).status).toBe(400);
    const paused = (await (await patch({ paused: true })).json()) as {
      status: string;
      pausedAt: string | null;
    };
    expect(paused).toMatchObject({ status: "waiting-on-others" });
    expect(paused.pausedAt).toBeString();
    const resumed = (await (await patch({ paused: false })).json()) as { pausedAt: string | null };
    expect(resumed.pausedAt).toBeNull();
  });

  it("rejects an unknown status filter and a malformed id", async () => {
    expect((await app.request("/api/work-streams?status=nope", { headers: auth })).status).toBe(
      400,
    );
    expect((await app.request("/api/work-streams/not-a-uuid", { headers: auth })).status).toBe(404);
  });
});

describe("quick task", () => {
  const proposal = {
    title: "Merge the billing PR",
    kind: "ship",
    focus: "Get it merged once CI is green.",
    priority: "high",
    links: [
      {
        ref: { kind: "pr", provider: "github", url: "https://github.com/o/r/pull/5" },
        title: "r #5",
      },
    ],
  };

  it("creates nothing when proposing, and a stream with its links on confirm", async () => {
    const quick = createApp(config);
    const bad = await quick.request("/api/work-streams/quick-task", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ ...proposal, title: "" }),
    });
    expect(bad.status).toBe(400);
    expect(await sql`select 1 from work_streams`).toHaveLength(0);

    const res = await quick.request("/api/work-streams/quick-task", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(proposal),
    });
    expect(res.status).toBe(201);
    const stream = (await res.json()) as { summary: string; links: { kind: string }[] };
    expect(stream.summary).toBe("Kind: ship. Get it merged once CI is green.");
    expect(stream.links.map((l) => l.kind)).toEqual(["pr"]);
  });

  it("rejects a PR link that is not http(s)", async () => {
    const res = await app.request("/api/work-streams/quick-task", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        ...proposal,
        links: [{ ref: { kind: "pr", provider: "github", url: "javascript:alert(1)" } }],
      }),
    });
    expect(res.status).toBe(400);
  });

  it("proposes without writing anything, and reports a failed model call", async () => {
    const ok = createWorkStreamRoutes(config, { propose: async () => proposal as never });
    const body = JSON.stringify({ message: "ship it", provider: "p", model: "m" });
    const res = await ok.request("/quick-task/propose", { method: "POST", body });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { title: string }).title).toBe(proposal.title);
    expect(await sql`select 1 from work_streams`).toHaveLength(0);

    const bad = await ok.request("/quick-task/propose", {
      method: "POST",
      body: JSON.stringify({ message: "", provider: "p", model: "m" }),
    });
    expect(bad.status).toBe(400);

    const failing = createWorkStreamRoutes(config, {
      propose: async () => {
        throw new Error("model down");
      },
    });
    expect((await failing.request("/quick-task/propose", { method: "POST", body })).status).toBe(
      502,
    );
  });

  it("refuses to save a link to a workspace that doesn't exist", async () => {
    const res = await app.request("/api/work-streams/quick-task", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        ...proposal,
        links: [
          { ref: { kind: "workspace", workspaceId: "00000000-0000-4000-8000-000000000000" } },
        ],
      }),
    });
    expect(res.status).toBe(400);
    expect(await sql`select 1 from work_streams`).toHaveLength(0);
  });
});
