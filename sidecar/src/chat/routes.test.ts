import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

const url =
  process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  allowedOrigins: null,
  databaseUrl: url,
  secrets: {}, // no provider keys configured
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions RESTART IDENTITY CASCADE`;
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
