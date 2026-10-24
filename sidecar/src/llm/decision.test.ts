import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import {
  DEFAULT_DECISION_MODEL_CONFIG,
  decide,
  getDecisionModelConfig,
  saveDecisionModelConfig,
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
    expect(await getDecisionModelConfig()).toEqual(DEFAULT_DECISION_MODEL_CONFIG);
  });

  it("keeps the model when only auto mode is toggled", async () => {
    await saveDecisionModelConfig({ model: { provider: "custom:abc", model: "jev" } });
    const saved = await saveDecisionModelConfig({ autoApproveTools: true });
    expect(saved).toEqual({
      model: { provider: "custom:abc", model: "jev" },
      autoApproveTools: true,
      autoApproveHeadsDown: false,
    });
  });
});

describe("decide through System One", () => {
  const schema = z.object({ ok: z.boolean() });
  const systemOne = {
    questions: { ok: { type: "noul" as const, instructions: "Is it ok?" } },
    toAnswer: (p: Record<string, number>) => ({ ok: (p.ok ?? 0) > 0.5 }),
  };

  async function systemOneSelection() {
    const row = await createCustomProvider({
      name: "system one",
      baseUrl: "http://127.0.0.1:11434/",
      apiKind: "ollama-systemone",
      models: ["nimble"],
      headerNames: [],
    });
    return { provider: `custom:${row.id}`, model: "nimble" };
  }

  it("posts the prompt as state with the questions, and maps the answers", async () => {
    const selection = await systemOneSelection();
    const calls: { url: string; body: Record<string, unknown> }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) });
      return Response.json({
        model: "nimble",
        answers: { ok: { noul: 0.9 } },
        usage: { input_tokens: 10, output_tokens: 1 },
      });
    }) as unknown as typeof fetch;

    const answer = await decide(config, selection, {
      system: "sys",
      prompt: "question",
      schema,
      systemOne,
      fetchImpl,
    });

    expect(answer).toEqual({ ok: true });
    expect(calls[0]?.url).toBe("http://127.0.0.1:11434/v1/systemone");
    expect(calls[0]?.body).toEqual({
      model: "nimble",
      state: "question",
      questions: systemOne.questions,
    });
  });

  it("throws when an answer is missing", async () => {
    const selection = await systemOneSelection();
    const fetchImpl = (async () => Response.json({ answers: {} })) as unknown as typeof fetch;

    await expect(
      decide(config, selection, { system: "s", prompt: "p", schema, systemOne, fetchImpl }),
    ).rejects.toThrow("no answer for ok");
  });

  it("throws for a decision that has no System One questions", async () => {
    const selection = await systemOneSelection();
    await expect(decide(config, selection, { system: "s", prompt: "p", schema })).rejects.toThrow(
      "System One",
    );
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

  it("sends the provider's API key and custom headers", async () => {
    const selection = await ollamaSelection();
    const id = selection.provider.slice("custom:".length);
    const withSecrets: Config = {
      ...config,
      customProviderSecrets: { [id]: { apiKey: "sk-test", headers: { "X-Team": "core" } } },
    };
    let headers: Record<string, string> = {};
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      headers = init.headers as Record<string, string>;
      return Response.json({ message: { content: '{"ok":true}' } });
    }) as unknown as typeof fetch;

    await decide(withSecrets, selection, { system: "s", prompt: "p", schema, fetchImpl });
    expect(headers).toMatchObject({ Authorization: "Bearer sk-test", "X-Team": "core" });
  });

  // The body is the user's conversation, so it never follows a redirect elsewhere.
  it("refuses a redirect to another origin", async () => {
    const selection = await ollamaSelection();
    const urls: string[] = [];
    const fetchImpl = (async (url: string) => {
      urls.push(url);
      return new Response(null, { status: 307, headers: { location: "http://localhost:9999/x" } });
    }) as unknown as typeof fetch;

    await expect(
      decide(config, selection, { system: "s", prompt: "p", schema, fetchImpl }),
    ).rejects.toThrow("another origin");
    expect(urls).toHaveLength(1);
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
