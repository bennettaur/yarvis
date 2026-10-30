import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import { saveProviderModel } from "./catalog.ts";
import { saveDecisionModelConfig } from "./decision.ts";

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
    expect(await res.json()).toEqual({
      model: null,
      autoApproveTools: false,
      autoApproveHeadsDown: false,
      routeComplexity: false,
      pickSpecialists: false,
    });
  });

  it("clears the model without turning auto mode off", async () => {
    await patch(
      JSON.stringify({ model: { provider: "custom:a", model: "jev" }, autoApproveTools: true }),
    );
    const res = await patch(JSON.stringify({ model: null }));
    expect(await res.json()).toEqual({
      model: null,
      autoApproveTools: true,
      autoApproveHeadsDown: false,
      routeComplexity: false,
      pickSpecialists: false,
    });
  });

  it("rejects a malformed body", async () => {
    expect((await patch(JSON.stringify({ autoApproveTools: "yes" }))).status).toBe(400);
    expect((await patch("not json")).status).toBe(400);
    expect((await patch(JSON.stringify({ model: { provider: "p", model: "../x" } }))).status).toBe(
      400,
    );
  });
});

describe("POST /api/decision-model/try", () => {
  function tryDecision(body: unknown) {
    return app().request("/api/decision-model/try", {
      method: "POST",
      headers: jsonAuth,
      body: JSON.stringify(body),
    });
  }

  // The route uses the real network path, so the saved model points at a port
  // nothing listens on: what is tested here is everything before the call.
  async function saveUnreachableDecisionModel() {
    const row = await createCustomProvider({
      name: "local ollama",
      baseUrl: "http://127.0.0.1:9",
      apiKind: "ollama",
      models: ["jev"],
      headerNames: [],
    });
    const provider = `custom:${row.id}`;
    await saveProviderModel({ providerId: provider, modelId: "jev", capabilities: ["decision"] });
    await saveDecisionModelConfig({ model: { provider, model: "jev" } });
  }

  const custom = {
    instructions: "Judge the tone.",
    input: "Where is it?",
    options: [{ value: "calm" }, { value: "urgent" }],
  };

  it("needs either a specialist or instructions with options", async () => {
    expect((await tryDecision({ input: "x" })).status).toBe(400);
    expect((await tryDecision({ ...custom, specialist: "complexity-router" })).status).toBe(400);
    expect((await tryDecision({ instructions: "i", input: "x" })).status).toBe(400);
    expect(
      (await tryDecision({ ...custom, options: [{ value: "a b" }, { value: "c" }] })).status,
    ).toBe(400);
  });

  it("refuses to run with no decision model selected", async () => {
    expect((await tryDecision(custom)).status).toBe(409);
  });

  it("refuses a specialist that isn't a decision specialist", async () => {
    await saveUnreachableDecisionModel();
    const res = await tryDecision({ specialist: "planner", input: "x" });
    expect(res.status).toBe(404);
  });

  it("reports a failed call rather than an answer", async () => {
    await saveUnreachableDecisionModel();
    const res = await tryDecision({ specialist: "complexity-router", input: "Plan my week" });
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });
});
