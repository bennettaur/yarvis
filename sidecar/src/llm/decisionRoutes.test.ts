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
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-decision-routes-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

function patch(body: string) {
  return app().request("/api/decision-model", { method: "PATCH", headers: jsonAuth, body });
}

describe("GET/PATCH /api/decision-model", () => {
  it("requires the bearer token", async () => {
    expect((await app().request("/api/decision-model")).status).toBe(401);
  });

  it("answers off with no model before anything is saved", async () => {
    const res = await app().request("/api/decision-model", { headers: auth });
    expect(await res.json()).toEqual({ model: null, autoApproveTools: false });
  });

  it("clears the model without turning auto mode off", async () => {
    await patch(
      JSON.stringify({ model: { provider: "custom:a", model: "jev" }, autoApproveTools: true }),
    );
    const res = await patch(JSON.stringify({ model: null }));
    expect(await res.json()).toEqual({ model: null, autoApproveTools: true });
  });

  it("rejects a malformed body", async () => {
    expect((await patch(JSON.stringify({ autoApproveTools: "yes" }))).status).toBe(400);
    expect((await patch("not json")).status).toBe(400);
    expect((await patch(JSON.stringify({ model: { provider: "p", model: "../x" } }))).status).toBe(
      400,
    );
  });
});
