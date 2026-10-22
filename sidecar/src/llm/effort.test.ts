import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateText } from "ai";
import type { Config } from "../config.ts";
import {
  type CustomProviderApiKind,
  type CustomProviderModel,
  createCustomProvider,
} from "../customProviders/service.ts";
import { CUSTOM_PROVIDER_PREFIX, resolveModel } from "./providers.ts";

let settingsDir: string;
let originalSettingsPath: string | undefined;
let server: ReturnType<typeof Bun.serve> | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-effort-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  server?.stop(true);
  server = undefined;
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

const RESPONSES_REPLY = {
  id: "resp_1",
  created_at: 0,
  model: "m",
  object: "response",
  status: "completed",
  output: [
    {
      type: "message",
      id: "msg_1",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: "OK", annotations: [] }],
    },
  ],
  usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
};

const MESSAGES_REPLY = {
  id: "msg_1",
  type: "message",
  role: "assistant",
  model: "m",
  content: [{ type: "text", text: "OK" }],
  stop_reason: "end_turn",
  stop_sequence: null,
  usage: { input_tokens: 1, output_tokens: 1 },
};

const CHAT_COMPLETIONS_REPLY = {
  id: "chatcmpl_1",
  object: "chat.completion",
  created: 0,
  model: "m",
  choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
};

/** Saves a provider pointed at a fake gateway, sends one prompt, and returns the request body. */
async function requestBodyFor(
  apiKind: CustomProviderApiKind,
  model: CustomProviderModel,
  effort: "low" | "high" | undefined,
): Promise<Record<string, unknown>> {
  const bodies: Record<string, unknown>[] = [];
  server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      bodies.push((await req.json()) as Record<string, unknown>);
      return Response.json(
        apiKind === "anthropic"
          ? MESSAGES_REPLY
          : apiKind === "openai"
            ? RESPONSES_REPLY
            : CHAT_COMPLETIONS_REPLY,
      );
    },
  });
  const row = await createCustomProvider({
    name: "gateway",
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    apiKind,
    models: [model],
    headerNames: [],
  });
  const config = {
    secrets: {},
    customProviderSecrets: { [row.id]: { apiKey: "sk-fake", headers: {} } },
  } as unknown as Config;
  const resolved = await resolveModel(config, `${CUSTOM_PROVIDER_PREFIX}${row.id}`, model.id, {
    effort,
  });
  await generateText({ model: resolved, system: "Be brief.", prompt: "hi" });
  return bodies[0] ?? {};
}

describe("resolveModel with an effort level", () => {
  it("sends the effort to a proxy's Responses model tagged reasoning", async () => {
    const body = await requestBodyFor(
      "openai",
      { id: "bedrock-claude-opus-5-5", capabilities: ["chat", "reasoning"] },
      "high",
    );
    // The SDK doesn't recognize the alias as a reasoning model, so this only
    // arrives because the tag vouches for it.
    expect((body.reasoning as { effort?: string } | undefined)?.effort).toBe("high");
    // Forcing reasoning would otherwise move the system prompt to OpenAI's `developer` role.
    expect((body.input as { role?: string }[])[0]?.role).toBe("system");
  });

  it("asks a tagged Responses model for its reasoning back, with or without an effort", async () => {
    const body = await requestBodyFor(
      "openai",
      { id: "azure-gpt-5", capabilities: ["chat", "reasoning"] },
      undefined,
    );
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["reasoning.encrypted_content"]);
  });

  it("doesn't ask an untagged Responses model for reasoning, which OpenAI would reject", async () => {
    const body = await requestBodyFor(
      "openai",
      { id: "gpt-4o", capabilities: ["chat"] },
      undefined,
    );
    expect(body.store).toBe(false);
    expect(body.include).toBeUndefined();
  });

  it("sends the effort to a /chat/completions proxy and keeps its system prompt as system", async () => {
    const body = await requestBodyFor(
      "openai-chat",
      { id: "gpt-oss-120b", capabilities: ["chat", "reasoning"] },
      "high",
    );
    expect(body.reasoning_effort).toBe("high");
    expect((body.messages as { role?: string }[])[0]?.role).toBe("system");
  });

  it("sends nothing to a model that isn't tagged reasoning", async () => {
    const body = await requestBodyFor("openai", { id: "gpt-4o", capabilities: ["chat"] }, "high");
    expect(body.reasoning).toBeUndefined();
  });

  it("sends nothing when no effort is chosen", async () => {
    const body = await requestBodyFor(
      "openai",
      { id: "bedrock-claude-opus-5-5", capabilities: ["chat", "reasoning"] },
      undefined,
    );
    expect(body.reasoning).toBeUndefined();
  });

  it("maps the effort onto an Anthropic-kind proxy's own field", async () => {
    const body = await requestBodyFor(
      "anthropic",
      { id: "claude-opus-4-7", capabilities: ["chat", "reasoning"] },
      "low",
    );
    expect((body.output_config as { effort?: string } | undefined)?.effort).toBe("low");
  });
});
