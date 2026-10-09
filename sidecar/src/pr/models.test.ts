import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { defaultProviderModel } from "../llm/providers.ts";
import {
  DEFAULT_PR_MODEL_CONFIG,
  getPrModelConfig,
  resolvePrModel,
  savePrModelConfig,
} from "./models.ts";

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-pr-models-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

const noSecrets: Config = {
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

describe("PR model config", () => {
  it("answers every feature unset before anything is configured", async () => {
    expect(await getPrModelConfig()).toEqual(DEFAULT_PR_MODEL_CONFIG);
  });

  it("keeps one feature's model when the other is saved", async () => {
    await savePrModelConfig({ guide: { provider: "anthropic", model: "claude-opus-5-5" } });
    await savePrModelConfig({ ask: { provider: "cerebras", model: "llama-3.3-70b" } });

    expect(await getPrModelConfig()).toEqual({
      guide: { provider: "anthropic", model: "claude-opus-5-5" },
      ask: { provider: "cerebras", model: "llama-3.3-70b" },
    });
  });

  it("clears a feature by saving it as null", async () => {
    await savePrModelConfig({ guide: { provider: "anthropic", model: "claude-opus-5-5" } });
    await savePrModelConfig({ guide: null });

    expect((await getPrModelConfig()).guide).toBeNull();
  });
});

describe("resolvePrModel", () => {
  it("returns the saved model for the feature", async () => {
    await savePrModelConfig({ ask: { provider: "cerebras", model: "llama-3.3-70b" } });
    expect(await resolvePrModel(noSecrets, "ask")).toEqual({
      provider: "cerebras",
      model: "llama-3.3-70b",
    });
  });

  it("falls back to the default chat model when the feature is unset", async () => {
    await savePrModelConfig({ ask: { provider: "cerebras", model: "llama-3.3-70b" } });
    expect(await resolvePrModel(noSecrets, "guide")).toEqual(await defaultProviderModel(noSecrets));
  });
});
