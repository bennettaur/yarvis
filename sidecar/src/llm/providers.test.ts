import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { createCustomProvider } from "../customProviders/service.ts";
import {
  DEFAULT_MODELS,
  listProviderModels,
  resetProviderModels,
  saveProviderModel,
} from "./catalog.ts";
import {
  availableProviders,
  CUSTOM_PROVIDER_PREFIX,
  defaultProviderModel,
  resolveModel,
} from "./providers.ts";

function configWithSecrets(secrets: Config["customProviderSecrets"] = {}): Config {
  return {
    port: 0,
    token: "t",
    tokenGenerated: false,
    attentionToken: "test-attention-token",
    mcpToken: "test-mcp-token",
    allowedOrigins: null,
    databaseUrl: undefined,
    workspacesRoot: "/tmp/yarvis-test-workspaces",
    secrets: {},
    customProviderSecrets: secrets,
    mcpSecrets: {},
    embeddingsSecrets: { headers: {} },
    telegram: { allowedChatIds: [], otpWindowMinutes: 120 },
  };
}

// Custom providers and the model catalogue now live in ~/.yarvis/settings.json,
// not Postgres — none of this file needs a database anymore. Isolate each test
// in its own settings file so it never touches the real one.
let settingsDir: string;
let originalSettingsPath: string | undefined;

beforeEach(async () => {
  settingsDir = await mkdtemp(join(tmpdir(), "yarvis-llm-providers-"));
  originalSettingsPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(settingsDir, "settings.json");
});

afterEach(async () => {
  if (originalSettingsPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalSettingsPath;
  await rm(settingsDir, { recursive: true, force: true });
});

describe("availableProviders", () => {
  it("returns only built-ins when no database is provided", async () => {
    const providers = await availableProviders(configWithSecrets());
    expect(providers.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "bedrock",
      "cerebras",
      "gemini",
    ]);
  });

  it("marks Cerebras available only once its key is configured", async () => {
    const unkeyed = await availableProviders(configWithSecrets());
    expect(unkeyed.find((p) => p.id === "cerebras")?.available).toBe(false);

    const config: Config = { ...configWithSecrets(), secrets: { cerebrasApiKey: "csk-fake" } };
    const keyed = await availableProviders(config);
    expect(keyed.find((p) => p.id === "cerebras")?.available).toBe(true);
  });

  it("appends configured custom providers when given a database", async () => {
    const row = await createCustomProvider({
      name: "litellm",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai",
      models: ["gpt-4o", "claude-via-proxy"],
      headerNames: ["X-Tenant"],
    });
    const providers = await availableProviders(configWithSecrets());
    const custom = providers.find((p) => p.id === `${CUSTOM_PROVIDER_PREFIX}${row.id}`);
    expect(custom?.label).toBe("litellm");
    expect(custom?.models).toEqual([
      { id: "gpt-4o", capabilities: ["chat"] },
      { id: "claude-via-proxy", capabilities: ["chat"] },
    ]);
    expect(custom?.custom).toBe(true);
    expect(custom?.available).toBe(true);
  });

  it("marks a custom provider unavailable when it has no models", async () => {
    const row = await createCustomProvider({
      name: "empty",
      baseUrl: "https://empty.example.com",
      apiKind: "openai",
      models: [],
      headerNames: [],
    });
    const providers = await availableProviders(configWithSecrets());
    expect(providers.find((p) => p.id === `${CUSTOM_PROVIDER_PREFIX}${row.id}`)?.available).toBe(
      false,
    );
  });
});

describe("the model catalogue", () => {
  it("tags the bundled Gemini models so a TTS model is not a chat choice", async () => {
    const providers = await availableProviders(configWithSecrets());
    const gemini = providers.find((p) => p.id === "gemini");
    const tts = gemini?.models.filter((m) => m.capabilities.includes("tts")) ?? [];
    expect(tts.length).toBeGreaterThan(0);
    expect(tts.every((m) => !m.capabilities.includes("chat"))).toBe(true);
  });

  it("narrows every provider to the requested capability", async () => {
    const chatOnly = await availableProviders(configWithSecrets(), "chat");
    const gemini = chatOnly.find((p) => p.id === "gemini");
    expect(gemini?.models.length).toBeGreaterThan(0);
    expect(gemini?.models.every((m) => m.capabilities.includes("chat"))).toBe(true);
  });

  it("lets configured rows replace a provider's bundled models", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash",
      capabilities: ["chat"],
    });
    const providers = await availableProviders(configWithSecrets());
    expect(providers.find((p) => p.id === "gemini")?.models).toEqual([
      { id: "gemini-9-flash", capabilities: ["chat"] },
    ]);
  });

  it("hides a disabled model without forgetting its tags", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash",
      capabilities: ["chat"],
    });
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash-tts",
      capabilities: ["tts"],
      enabled: false,
    });
    const providers = await availableProviders(configWithSecrets());
    expect(providers.find((p) => p.id === "gemini")?.models.map((m) => m.id)).toEqual([
      "gemini-9-flash",
    ]);
    expect((await listProviderModels()).length).toBe(2);
  });

  it("returns a provider to its defaults once its rows are cleared", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash",
      capabilities: ["chat"],
    });
    await resetProviderModels("gemini");
    const providers = await availableProviders(configWithSecrets());
    expect(providers.find((p) => p.id === "gemini")?.models.map((m) => m.id)).toEqual(
      DEFAULT_MODELS.gemini!.map((m) => m.id),
    );
  });

  it("never picks a speech model as the chat default", async () => {
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash-tts",
      capabilities: ["tts"],
      sortOrder: 0,
    });
    await saveProviderModel({
      providerId: "gemini",
      modelId: "gemini-9-flash",
      capabilities: ["chat"],
      sortOrder: 1,
    });
    const config: Config = { ...configWithSecrets(), secrets: { geminiApiKey: "x" } };
    expect(await defaultProviderModel(config)).toEqual({
      provider: "gemini",
      model: "gemini-9-flash",
    });
  });
});

describe("defaultProviderModel", () => {
  it("prefers a configured key provider over always-available Bedrock", async () => {
    // Bedrock reports available unconditionally; with only a Gemini key set the
    // default must still be Gemini, not Bedrock.
    const config: Config = { ...configWithSecrets(), secrets: { geminiApiKey: "x" } };
    const result = await defaultProviderModel(config);
    expect(result?.provider).toBe("gemini");
    expect(result?.model).toBeTruthy();
  });

  it("prefers Anthropic when both Anthropic and Gemini are configured", async () => {
    const config: Config = {
      ...configWithSecrets(),
      secrets: { anthropicApiKey: "a", geminiApiKey: "g" },
    };
    const result = await defaultProviderModel(config);
    expect(result?.provider).toBe("anthropic");
  });

  it("falls back to Bedrock when no other provider is configured", async () => {
    const result = await defaultProviderModel(configWithSecrets());
    expect(result?.provider).toBe("bedrock");
  });

  it("picks Cerebras when it is the only keyed provider", async () => {
    const config: Config = { ...configWithSecrets(), secrets: { cerebrasApiKey: "csk-fake" } };
    const result = await defaultProviderModel(config);
    expect(result?.provider).toBe("cerebras");
    expect(result?.model).toBeTruthy();
  });
});

describe("resolveModel for Cerebras", () => {
  it("builds a chat-completions model from the configured key", async () => {
    const config: Config = { ...configWithSecrets(), secrets: { cerebrasApiKey: "csk-fake" } };
    const model = await resolveModel(config, "cerebras", "zai-glm-4.6");
    expect((model as { modelId?: string }).modelId).toBe("zai-glm-4.6");
    // Cerebras has no Responses API, so the model must be the chat-completions
    // variant. `modelId` alone can't tell the two apart.
    expect((model as { provider?: string }).provider).toBe("openai.chat");
  });

  it("throws when no key is configured", async () => {
    await expect(resolveModel(configWithSecrets(), "cerebras", "zai-glm-4.6")).rejects.toThrow(
      "Cerebras API key not configured",
    );
  });
});

describe("resolveModel for custom providers", () => {
  it("builds an openai-kind model from the row plus stored secrets", async () => {
    const row = await createCustomProvider({
      name: "litellm",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai",
      models: ["gpt-4o"],
      headerNames: ["X-Tenant"],
    });
    const config = configWithSecrets({
      [row.id]: { apiKey: "sk-fake", headers: { "X-Tenant": "team-a" } },
    });
    const model = await resolveModel(config, `${CUSTOM_PROVIDER_PREFIX}${row.id}`, "gpt-4o");
    expect((model as { modelId?: string }).modelId).toBe("gpt-4o");
  });

  it("builds an openai-chat model targeting /chat/completions", async () => {
    const row = await createCustomProvider({
      name: "litellm-chat",
      baseUrl: "https://litellm.example.com/v1",
      apiKind: "openai-chat",
      models: ["gpt-4o"],
      headerNames: [],
    });
    const model = await resolveModel(
      configWithSecrets(),
      `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
      "gpt-4o",
    );
    expect((model as { modelId?: string }).modelId).toBe("gpt-4o");
  });

  it("builds an anthropic-kind model when the row declares it", async () => {
    const row = await createCustomProvider({
      name: "litellm-anthropic",
      baseUrl: "https://litellm.example.com/anthropic",
      apiKind: "anthropic",
      models: ["claude-sonnet-4-6"],
      headerNames: [],
    });
    const model = await resolveModel(
      configWithSecrets(),
      `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
      "claude-sonnet-4-6",
    );
    expect((model as { modelId?: string }).modelId).toBe("claude-sonnet-4-6");
  });

  it("throws when the custom provider id is unknown", async () => {
    await expect(
      resolveModel(configWithSecrets(), `${CUSTOM_PROVIDER_PREFIX}does-not-exist`, "x"),
    ).rejects.toThrow();
  });
});
