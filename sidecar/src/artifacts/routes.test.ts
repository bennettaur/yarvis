import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import * as schema from "../db/schema.ts";
import { artifactListenerCount, publishArtifactChange } from "./hub.ts";
import { createArtifact, createDiagram, deleteArtifact, updateDiagram } from "./service.ts";

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
    // An id with a valid UUID inside it is still malformed, not a database error.
    const padded = await app.request(`/api/artifacts/${artifact.id}x`, { headers: auth });
    expect(padded.status).toBe(404);
  });

  it("deletes an artifact", async () => {
    const artifact = await createArtifact(db, { title: "Notes" });
    const del = (id: string) =>
      app.request(`/api/artifacts/${id}`, { method: "DELETE", headers: auth });
    expect(await (await del(artifact.id)).json()).toEqual({ deleted: true });
    expect(await (await del(artifact.id)).json()).toEqual({ deleted: false });
    expect(await (await del("not-a-uuid")).json()).toEqual({ deleted: false });
    expect(await (await del(`x${crypto.randomUUID()}`)).json()).toEqual({ deleted: false });
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
    expect((await post({ ids: [`${crypto.randomUUID()}x`] })).status).toBe(400);
    expect((await post({ ids: [] })).status).toBe(400);
    const tooMany = Array.from({ length: 101 }, () => crypto.randomUUID());
    expect((await post({ ids: tooMany })).status).toBe(400);
  });

  it("answers 503 when no database is configured", async () => {
    const noDb = createApp({ ...config, databaseUrl: undefined });
    const res = await noDb.request("/api/artifacts", { headers: auth });
    expect(res.status).toBe(503);
  });

  /** Opens an artifact's stream, with a bounded read so a missing frame fails the test rather than hanging it. */
  async function openStream(id: string) {
    const res = await app.request(`/api/artifacts/${id}/stream`, { headers: auth });
    expect(res.status).toBe(200);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    const stream = {
      reader,
      text: "",
      async readUntil(needle: string) {
        const deadline = Date.now() + 2_000;
        while (!stream.text.includes(needle)) {
          const timeout = new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error(`no ${needle} frame`)), deadline - Date.now()),
          );
          const { value, done } = await Promise.race([reader.read(), timeout]);
          if (done) break;
          stream.text += decoder.decode(value);
        }
      },
    };
    return stream;
  }

  it("streams a change signal for one artifact, and ends after its delete", async () => {
    const artifact = await createDiagram(db, {
      title: "Flow",
      elements: [{ id: "a", type: "rectangle", x: 0, y: 0, width: 100, height: 50 }],
    });
    const stream = await openStream(artifact.id);
    const { reader } = stream;
    const readUntil = (needle: string) => stream.readUntil(needle);
    await readUntil('"ping"');
    await updateDiagram(db, artifact.id, { changes: { upsert: [{ id: "a", x: 40 }] } });
    await readUntil('"updated"');
    await deleteArtifact(db, artifact.id);
    await readUntil('"deleted"');
    // The stream closes itself once the artifact is gone.
    expect((await reader.read()).done).toBe(true);
  });

  it("sends a delete that lands before a pending update, then ends", async () => {
    const artifact = await createArtifact(db, { title: "Notes" });
    const stream = await openStream(artifact.id);
    await stream.readUntil('"ping"');
    // Both before the stream can send either, so the update is still pending when the delete lands.
    publishArtifactChange(artifact.id, "updated");
    publishArtifactChange(artifact.id, "deleted");
    publishArtifactChange(artifact.id, "updated");
    await stream.readUntil('"deleted"');
    expect(stream.text).not.toContain('"updated"');
    expect((await stream.reader.read()).done).toBe(true);
  });

  it("stops following the artifact once the pane disconnects", async () => {
    const artifact = await createArtifact(db, { title: "Notes" });
    const controller = new AbortController();
    const res = await app.request(`/api/artifacts/${artifact.id}/stream`, {
      headers: auth,
      signal: controller.signal,
    });
    const reader = res.body!.getReader();
    await reader.read();
    expect(artifactListenerCount(artifact.id)).toBe(1);
    controller.abort();
    const deadline = Date.now() + 2_000;
    while (artifactListenerCount(artifact.id) > 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(artifactListenerCount(artifact.id)).toBe(0);
  });

  it("refuses a stream for a malformed id, or an artifact that doesn't exist", async () => {
    const malformed = await app.request("/api/artifacts/nope/stream", { headers: auth });
    expect(malformed.status).toBe(404);
    const missing = await app.request(
      "/api/artifacts/00000000-0000-4000-8000-000000000000/stream",
      { headers: auth },
    );
    expect(missing.status).toBe(404);
  });
});
