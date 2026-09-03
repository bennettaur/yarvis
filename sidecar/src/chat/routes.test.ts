import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import postgres from "postgres";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";

const url = process.env.TEST_DATABASE_URL ?? "postgres://localhost:5432/yarvis_test";
const sql = postgres(url, { max: 1 });

let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  // Custom providers now live in ~/.yarvis/settings.json, not Postgres — point
  // each test at an isolated file so this suite never touches the real one.
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-chat-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: url,
  workspacesRoot: "/tmp/yarvis-test-workspaces",
  secrets: {}, // no provider keys configured
  customProviderSecrets: {},
  mcpSecrets: {},
  embeddingsSecrets: { headers: {} },
  telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
};
const app = createApp(config);
const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

beforeEach(async () => {
  await sql`TRUNCATE tasks, chat_messages, chat_sessions, custom_providers, provider_models RESTART IDENTITY CASCADE`;
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
      "cerebras",
      "gemini",
    ]);
    // No keys configured, so the key-based providers are unavailable.
    expect(providers.find((p) => p.id === "anthropic")?.available).toBe(false);
  });

  it("lists configured custom providers alongside built-ins", async () => {
    const row = await createCustomProvider({
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
      models: { id: string; capabilities: string[] }[];
      custom?: boolean;
    }[];
    const custom = providers.find((p) => p.id === `custom:${row.id}`);
    expect(custom?.label).toBe("litellm");
    expect(custom?.models).toEqual([{ id: "gpt-4o", capabilities: ["chat"] }]);
    expect(custom?.custom).toBe(true);
  });

  it("offers only chat models by default and the named capability on request", async () => {
    const chat = await app.request("/api/chat/providers", { headers: auth });
    const gemini = ((await chat.json()) as { id: string; models: { id: string }[] }[]).find(
      (p) => p.id === "gemini",
    );
    expect(gemini?.models.every((m) => !m.id.endsWith("-tts"))).toBe(true);

    const tts = await app.request("/api/chat/providers?capability=tts", { headers: auth });
    const geminiTts = ((await tts.json()) as { id: string; models: { id: string }[] }[]).find(
      (p) => p.id === "gemini",
    );
    expect(geminiTts?.models.length).toBeGreaterThan(0);
    expect(geminiTts?.models.every((m) => m.id.endsWith("-tts"))).toBe(true);
  });

  it("rejects an unknown capability", async () => {
    const res = await app.request("/api/chat/providers?capability=telepathy", { headers: auth });
    expect(res.status).toBe(400);
  });

  it("accepts a custom provider id in chat requests (schema-level)", async () => {
    // The streaming call will fail trying to reach this nonexistent host, but
    // the request should pass schema validation and start the stream rather
    // than being rejected with a 400. A literal loopback URL would now be
    // rejected by the outbound-URL guard, so use a publicly-shaped host.
    const row = await createCustomProvider({
      name: "litellm",
      baseUrl: "https://litellm.example.invalid/v1",
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
    expect(((await res.json()) as { error: string }).error).toContain("Anthropic API key");
  });
});
