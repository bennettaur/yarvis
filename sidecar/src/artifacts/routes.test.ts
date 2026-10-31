import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { createArtifact } from "./service.ts";

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

beforeEach(async () => {
  await sql`TRUNCATE artifacts, events RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("/api/artifacts", () => {
  it("lists summaries without the content", async () => {
    await createArtifact(db, { title: "Morning brief", content: "# Today" });
    const res = await app.request("/api/artifacts", { headers: auth });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>[];
    expect(body.map((a) => a.title)).toEqual(["Morning brief"]);
    expect(body[0]).not.toHaveProperty("content");
    expect(body[0]?.length).toBe(7);
  });

  it("returns one artifact in full, and 404 for a missing or malformed id", async () => {
    const artifact = await createArtifact(db, { title: "Notes", content: "hello" });
    const res = await app.request(`/api/artifacts/${artifact.id}`, { headers: auth });
    expect(((await res.json()) as { content: string }).content).toBe("hello");

    const missing = await app.request(`/api/artifacts/${crypto.randomUUID()}`, { headers: auth });
    expect(missing.status).toBe(404);
    const malformed = await app.request("/api/artifacts/not-a-uuid", { headers: auth });
    expect(malformed.status).toBe(404);
  });

  it("deletes an artifact", async () => {
    const artifact = await createArtifact(db, { title: "Notes" });
    const del = (id: string) =>
      app.request(`/api/artifacts/${id}`, { method: "DELETE", headers: auth });
    expect(await (await del(artifact.id)).json()).toEqual({ deleted: true });
    expect(await (await del(artifact.id)).json()).toEqual({ deleted: false });
    expect(await (await del("not-a-uuid")).json()).toEqual({ deleted: false });
  });

  it("deletes several artifacts at once, skipping ones already gone", async () => {
    const a = await createArtifact(db, { title: "A" });
    const b = await createArtifact(db, { title: "B" });
    const keep = await createArtifact(db, { title: "Keep" });
    const res = await app.request("/api/artifacts/delete", {
      method: "POST",
      headers: { ...auth, "content-type": "application/json" },
      body: JSON.stringify({ ids: [a.id, b.id, crypto.randomUUID()] }),
    });
    expect(await res.json()).toEqual({ deleted: 2 });
    const left = (await (await app.request("/api/artifacts", { headers: auth })).json()) as {
      id: string;
    }[];
    expect(left.map((x) => x.id)).toEqual([keep.id]);
  });

  it("refuses a bulk delete with a malformed or empty list", async () => {
    const post = (body: unknown) =>
      app.request("/api/artifacts/delete", {
        method: "POST",
        headers: { ...auth, "content-type": "application/json" },
        body: JSON.stringify(body),
      });
    expect((await post({ ids: ["not-a-uuid"] })).status).toBe(400);
    expect((await post({ ids: [] })).status).toBe(400);
  });

  it("answers 503 when no database is configured", async () => {
    const noDb = createApp({ ...config, databaseUrl: undefined });
    const res = await noDb.request("/api/artifacts", { headers: auth });
    expect(res.status).toBe(503);
  });
});
