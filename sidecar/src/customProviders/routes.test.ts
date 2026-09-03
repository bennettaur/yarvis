import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

let dir: string;
let originalPath: string | undefined;

const config: Config = {
  port: 0,
  token: "test-token",
  tokenGenerated: false,
  attentionToken: "test-attention-token",
  mcpToken: "test-mcp-token",
  allowedOrigins: null,
  databaseUrl: undefined,
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
  dir = await mkdtemp(join(tmpdir(), "yarvis-custom-providers-routes-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("custom provider routes", () => {
  it("creates, lists, and updates a provider", async () => {
    const createRes = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "litellm",
        baseUrl: "https://litellm.example.com/v1",
        apiKind: "openai",
        models: ["gpt-4o"],
        headerNames: ["X-Tenant"],
      }),
    });
    expect(createRes.status).toBe(201);
    const created = (await createRes.json()) as { id: string; name: string };
    expect(created.name).toBe("litellm");

    const listRes = await app.request("/api/custom-providers", {
      headers: jsonAuth,
    });
    expect(listRes.status).toBe(200);
    const rows = (await listRes.json()) as { id: string }[];
    expect(rows.map((r) => r.id)).toContain(created.id);

    const patchRes = await app.request(`/api/custom-providers/${created.id}`, {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ models: ["gpt-4o-mini"] }),
    });
    expect(patchRes.status).toBe(200);
    const updated = (await patchRes.json()) as { models: string[] };
    expect(updated.models).toEqual(["gpt-4o-mini"]);
  });

  it("rejects invalid input", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({ name: "x", baseUrl: "not-a-url", apiKind: "openai" }),
    });
    expect(res.status).toBe(400);
  });

  it("accepts a loopback baseUrl for a local provider (e.g. Ollama)", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "ollama",
        baseUrl: "http://localhost:11434/v1",
        apiKind: "openai-chat",
      }),
    });
    expect(res.status).toBe(201);
  });

  it("still rejects non-loopback private baseUrls", async () => {
    const res = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "lan",
        baseUrl: "http://192.168.1.10:11434/v1",
        apiKind: "openai-chat",
      }),
    });
    expect(res.status).toBe(400);
  });

  it("deletes a provider", async () => {
    const createRes = await app.request("/api/custom-providers", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify({
        name: "doomed",
        baseUrl: "https://example.com",
        apiKind: "anthropic",
        models: [],
        headerNames: [],
      }),
    });
    const { id } = (await createRes.json()) as { id: string };

    const del = await app.request(`/api/custom-providers/${id}`, {
      method: "DELETE",
      headers: jsonAuth,
    });
    expect(del.status).toBe(204);

    const missing = await app.request(`/api/custom-providers/${id}`, {
      headers: jsonAuth,
    });
    expect(missing.status).toBe(404);
  });

  it("requires authentication", async () => {
    const res = await app.request("/api/custom-providers");
    expect(res.status).toBe(401);
  });
});
