import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";

/** No database URL: the setting must work without Postgres, unlike `/api/pr`. */
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
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-pr-model-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

describe("GET/PATCH /api/pr-models", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/pr-models")).status).toBe(401);
  });

  it("saves and reads a feature back", async () => {
    const res = await app().request("/api/pr-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ guide: { provider: "anthropic", model: "claude-opus-5-5" } }),
    });
    expect(res.status).toBe(200);

    const read = await app().request("/api/pr-models", { headers: auth });
    expect(await read.json()).toEqual({
      guide: { provider: "anthropic", model: "claude-opus-5-5" },
      ask: null,
    });
  });

  it("rejects a model id shaped like a path traversal", async () => {
    const res = await app().request("/api/pr-models", {
      method: "PATCH",
      headers: jsonAuth,
      body: JSON.stringify({ ask: { provider: "gemini", model: "../../v1beta/other" } }),
    });
    expect(res.status).toBe(400);
  });
});
