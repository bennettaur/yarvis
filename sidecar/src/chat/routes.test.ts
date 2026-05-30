import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { createCustomProvider } from "../customProviders/service.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });
const { db } = getDb(url);

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: url,
  secrets: {}, // no provider keys configured
  customProviderSecrets: {},
  embeddingsSecrets: { headers: {} },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions, custom_providers RESTART IDENTITY CASCADE`;
});

afterAll(async () => {
  await sql.end();
});

describe("chat routes", () => {
  it("lists providers with availability flags", async () => {
    const res = await app.request("/api/chat/providers", { headers: auth });
    expect(res.status).toBe(200);
    const providers = (await res.json()) as { id: string; available: boolean }[];
    expect(providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "bedrock",
      "gemini",
    ]);
    // No keys configured, so the key-based providers are unavailable.
    expect(providers.find((p) => p.id === "anthropic")?.available).toBe(false);
  });

  it("lists configured custom providers alongside built-ins", async () => {
    const row = await createCustomProvider(db, {
      name: "litellm",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai",
      models: ["gpt-4o"],
      headerNames: [],
    });
    const res = await app.request("/api/chat/providers", { headers: auth });
    const providers = (await res.json()) as {
      id: string;
      label: string;
      models: string[];
      custom?: boolean;
    }[];
    const custom = providers.find((p) => p.id === `custom:${row.id}`);
    expect(custom?.label).toBe("litellm");
    expect(custom?.models).toEqual(["gpt-4o"]);
    expect(custom?.custom).toBe(true);
  });

  it("accepts a custom provider id in chat requests (schema-level)", async () => {
    // The streaming call will fail trying to reach 127.0.0.1:1, but the
    // request should pass schema validation and start the stream rather than
    // being rejected with a 400.
    const row = await createCustomProvider(db, {
      name: "litellm",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKind: "openai",
      models: ["gpt-4o"],
      headerNames: [],
    });
    const session = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "x" }),
    });
    const { id } = (await session.json()) as { id: string };

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        sessionId: id,
        message: "hi",
        provider: `custom:${row.id}`,
        model: "gpt-4o",
      }),
    });
    expect(res.status).toBe(200);
  });

  it("creates a chat session", async () => {
    const res = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "Test" }),
    });
    expect(res.status).toBe(201);
  });

  it("rejects a chat request with an invalid body", async () => {
    const res = await app.request("/api/chat", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ message: "hi" }), // missing sessionId/provider/model
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when the chosen provider has no configured key", async () => {
    const session = await app.request("/api/chat/sessions", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ title: "x" }),
    });
    const { id } = (await session.json()) as { id: string };

    const res = await app.request("/api/chat", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        sessionId: id,
        message: "hello",
        provider: "anthropic",
        model: "claude-sonnet-4-6",
      }),
    });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain(
      "Anthropic API key",
    );
  });
});
