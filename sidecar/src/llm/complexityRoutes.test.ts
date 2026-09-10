import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

function app(): ReturnType<typeof createApp> {
  return createApp({
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
  } satisfies Config);
}

const auth = { Authorization: "Bearer test-token" };
const jsonAuth = { ...auth, "Content-Type": "application/json" };

let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-complexity-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

describe("GET/PATCH /api/complexity-models", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/complexity-models")).status).toBe(401);
    expect(
      (
        await app().request("/api/complexity-models", {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: "{}",
        })
      ).status,
    ).toBe(401);
  });

  it("saves and reads a tier back", async () => {
    const res = await app().request("/api/complexity-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ low: { provider: "cerebras", model: "llama-3.3-70b" } }),
    });
    expect(res.status).toBe(200);

    const read = await app().request("/api/complexity-models", { headers: auth });
    expect(await read.json()).toMatchObject({
      low: { provider: "cerebras", model: "llama-3.3-70b" },
    });
  });

  it("rejects an incomplete selection", async () => {
    const res = await app().request("/api/complexity-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ low: { provider: "cerebras" } }),
    });
    expect(res.status).toBe(400);
  });

  it("rejects a model id shaped like a path traversal", async () => {
    const res = await app().request("/api/complexity-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ low: { provider: "gemini", model: "../../v1beta/other" } }),
    });
    expect(res.status).toBe(400);
  });

  it("clears a tier by saving it as null", async () => {
    await app().request("/api/complexity-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ low: { provider: "cerebras", model: "llama-3.3-70b" } }),
    });
    const res = await app().request("/api/complexity-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ low: null }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ low: null });
  });
});
