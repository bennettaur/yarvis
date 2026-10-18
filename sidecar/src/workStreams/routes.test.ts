import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
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
  await sql`TRUNCATE work_streams, work_stream_links RESTART IDENTITY CASCADE`;
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

  it("rejects an unknown status filter and a malformed id", async () => {
    expect((await app.request("/api/work-streams?status=nope", { headers: auth })).status).toBe(
      400,
    );
    expect((await app.request("/api/work-streams/not-a-uuid", { headers: auth })).status).toBe(404);
  });
});
