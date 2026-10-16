import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import {
  DEFAULT_DECISION_CONFIG,
  decide,
  getDecisionConfig,
  saveDecisionConfig,
} from "./decision.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-decision-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

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

describe("decision model config", () => {
  it("is off with no model before anything is saved", async () => {
    expect(await getDecisionConfig()).toEqual(DEFAULT_DECISION_CONFIG);
  });

  it("keeps the model when only auto mode is toggled", async () => {
    await saveDecisionConfig({ model: { provider: "custom:abc", model: "jev" } });
    const saved = await saveDecisionConfig({ autoApproveTools: true });
    expect(saved).toEqual({
      model: { provider: "custom:abc", model: "jev" },
      autoApproveTools: true,
    });
  });
});

describe("decide through Ollama", () => {
  const schema = z.object({ ok: z.boolean() });

  async function ollamaSelection() {
    const row = await createCustomProvider({
      name: "local ollama",
      baseUrl: "http://127.0.0.1:11434/",
      apiKind: "ollama",
      models: ["jev"],
      headerNames: [],
    });
    return { provider: `custom:${row.id}`, model: "jev" };
  }

  it("posts to /api/chat with the schema as format and parses the answer", async () => {
    const selection = await ollamaSelection();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({ message: { role: "assistant", content: '{"ok":true}' } });
    }) as unknown as typeof fetch;

    const answer = await decide(config, selection, {
      system: "sys",
      prompt: "question",
      schema,
      fetchImpl,
    });

    expect(answer).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls[0]?.body).toMatchObject({
      model: "jev",
      stream: false,
      format: { type: "object", properties: { ok: { type: "boolean" } } },
    });
  });

  it("throws when the answer does not match the schema", async () => {
    const selection = await ollamaSelection();
    const fetchImpl = (async () =>
      Response.json({ message: { content: '{"ok":"yes"}' } })) as unknown as typeof fetch;

    await expect(
      decide(config, selection, { system: "s", prompt: "p", schema, fetchImpl }),
    ).rejects.toThrow();
  });

  it("throws on an error status", async () => {
    const selection = await ollamaSelection();
    const fetchImpl = (async () =>
      new Response("model not found", { status: 404 })) as unknown as typeof fetch;

    await expect(
      decide(config, selection, { system: "s", prompt: "p", schema, fetchImpl }),
    ).rejects.toThrow("404");
  });
});
