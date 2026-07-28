import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { EMBED_DIM } from "../db/schema.ts";

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

function validConfig(overrides: Record<string, unknown> = {}) {
  return {
    baseUrl: "http://localhost:11434/v1",
    model: "mxbai-embed-large",
    apiKind: "openai",
    dimensions: EMBED_DIM,
    headerNames: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await sql`TRUNCATE embeddings_config RESTART IDENTITY CASCADE`;
  await sql`TRUNCATE memories RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("embeddings config routes", () => {
  it("upserts a single config row in place across PUTs", async () => {
    const first = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify(validConfig({ model: "model-a" })),
    });
    expect(first.status).toBe(200);

    const second = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify(validConfig({ model: "model-b" })),
    });
    expect(second.status).toBe(200);

    // Singleton: the second PUT updates in place rather than inserting.
    const [{ n }] = await sql<{ n: number }[]>`
      SELECT count(*)::int AS n FROM embeddings_config`;
    expect(n).toBe(1);

    const getRes = await app.request("/api/memory/embeddings/config", {
      headers: jsonAuth,
    });
    const body = (await getRes.json()) as {
      config: { model: string } | null;
      health: { ok: boolean };
    };
    expect(body.config?.model).toBe("model-b");
  });

  it("returns null config and healthy state before any provider is set", async () => {
    const res = await app.request("/api/memory/embeddings/config", {
      headers: jsonAuth,
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      config: unknown | null;
      health: { ok: boolean; active: { kind: string } };
    };
    expect(body.config).toBeNull();
    expect(body.health.ok).toBe(true);
    // No provider + no Gemini key → offline hash fallback.
    expect(body.health.active.kind).toBe("hash");
  });

  it("rejects a dimension that doesn't match the column", async () => {
    const res = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify(validConfig({ dimensions: EMBED_DIM + 1 })),
    });
    expect(res.status).toBe(400);
  });

  it("rejects malformed input", async () => {
    const res = await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify({ baseUrl: "not-a-url", model: "", dimensions: 0 }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes the config", async () => {
    await app.request("/api/memory/embeddings/config", {
      method: "PUT",
      headers: jsonAuth,
      body: JSON.stringify(validConfig()),
    });

    const del = await app.request("/api/memory/embeddings/config", {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect((await del.json()) as { deleted: boolean }).toEqual({ deleted: true });

    const delAgain = await app.request("/api/memory/embeddings/config", {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect((await delAgain.json()) as { deleted: boolean }).toEqual({
      deleted: false,
    });
  });

  it("re-embeds stored memories and reports the count", async () => {
    // No provider configured, so the offline hash embedder is used end to end.
    for (const content of ["alpha fact", "beta note"]) {
      const add = await app.request("/api/memory", {
        method: "POST",
        headers: jsonAuth,
        body: JSON.stringify({ content }),
      });
      expect(add.status).toBe(201);
    }

    const res = await app.request("/api/memory/reembed", {
      method: "POST",
      headers: jsonAuth,
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as { reembedded: number }).toEqual({
      reembedded: 2,
    });
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/memory/embeddings/config");
    expect(res.status).toBe(401);
  });
});
