import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../app.ts";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import { saveProviderModel } from "../llm/catalog.ts";
import { saveDecisionModelConfig } from "../llm/decision.ts";
import { createDecisionPlaygroundRoutes } from "./decisionPlaygroundRoutes.ts";

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

let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-decision-playground-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

async function saveDecisionModel() {
  const row = await createCustomProvider({
    name: "local ollama",
    baseUrl: "http://127.0.0.1:11434",
    apiKind: "ollama",
    models: ["jev"],
    headerNames: [],
  });
  const provider = `custom:${row.id}`;
  await saveProviderModel({ providerId: provider, modelId: "jev", capabilities: ["decision"] });
  await saveDecisionModelConfig({ model: { provider, model: "jev" } });
  return { provider, model: "jev" };
}

/** An Ollama reply carrying `answer`, or a 500 when it is null; records each request body. */
function answering(answer: object | null) {
  const bodies: { format: unknown }[] = [];
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(JSON.parse(init.body as string));
    return answer === null
      ? new Response("boom", { status: 500 })
      : Response.json({ message: { content: JSON.stringify(answer) } });
  }) as unknown as typeof fetch;
  return { bodies, fetchImpl };
}

function tryDecision(body: unknown, fetchImpl?: typeof fetch) {
  return createDecisionPlaygroundRoutes(config, fetchImpl).request("/", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const custom = {
  instructions: "Judge the tone.",
  input: "Where is it?",
  options: [{ value: "calm" }, { value: "urgent" }],
};

describe("POST /api/decision-playground", () => {
  it("requires the bearer token", async () => {
    const res = await createApp(config).request("/api/decision-playground", { method: "POST" });
    expect(res.status).toBe(401);
  });

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
    await saveDecisionModel();
    expect((await tryDecision({ specialist: "planner", input: "x" })).status).toBe(404);
  });

  // `specialist-picker` has no choices of its own; leaving them out is the caller's mistake.
  it("answers 400, not a failed call, for a specialist asked without options it needs", async () => {
    await saveDecisionModel();
    const { bodies, fetchImpl } = answering({ reason: "r", choice: "x" });
    const res = await tryDecision({ specialist: "specialist-picker", input: "x" }, fetchImpl);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "a decision needs at least two options" });
    expect(bodies).toEqual([]);
  });

  it("answers with the pick, the model and how long it took", async () => {
    const selection = await saveDecisionModel();
    const { fetchImpl } = answering({ reason: "they asked twice", choice: "urgent" });
    const res = await tryDecision(custom, fetchImpl);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      choice: "urgent",
      reason: "they asked twice",
      model: selection,
      elapsedMs: expect.any(Number),
    });
  });

  it("lets given options replace a specialist's own choices", async () => {
    await saveDecisionModel();
    const { bodies, fetchImpl } = answering({ reason: "r", choice: "fast" });
    const res = await tryDecision(
      {
        specialist: "Complexity-Router",
        input: "x",
        options: [{ value: "fast" }, { value: "slow" }],
      },
      fetchImpl,
    );
    expect(res.status).toBe(200);
    expect(bodies[0]!.format).toMatchObject({
      properties: { choice: { enum: ["fast", "slow"] } },
    });
  });

  it("reports a failed call rather than an answer", async () => {
    await saveDecisionModel();
    const res = await tryDecision(
      { specialist: "complexity-router", input: "Plan my week" },
      answering(null).fetchImpl,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toMatchObject({ error: expect.any(String) });
  });
});
