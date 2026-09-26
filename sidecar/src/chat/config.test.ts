import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import { saveProviderModel } from "../llm/catalog.ts";
import { readSection, withSection } from "../settings/store.ts";
import { DEFAULT_CHAT_CONFIG, getChatBudget, getChatConfig, saveChatConfig } from "./config.ts";

const appConfig: Config = {
  port: 0,
  token: "t",
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

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-chat-config-"));
  originalPath = process.env.YARVIS_SETTINGS_PATH;
  process.env.YARVIS_SETTINGS_PATH = join(dir, "settings.json");
});

afterEach(async () => {
  if (originalPath === undefined) delete process.env.YARVIS_SETTINGS_PATH;
  else process.env.YARVIS_SETTINGS_PATH = originalPath;
  await rm(dir, { recursive: true, force: true });
});

describe("chat config", () => {
  it("returns the defaults when nothing is saved", async () => {
    expect(await getChatConfig()).toEqual(DEFAULT_CHAT_CONFIG);
  });

  it("defaults compaction to 200k tokens and fills it in for an older saved section", async () => {
    expect(DEFAULT_CHAT_CONFIG.compactAtTokens).toBe(200_000);
    await withSection<{ maxSteps: number }, void>("chatConfig", () => ({
      next: { maxSteps: 30 },
      result: undefined,
    }));
    expect((await getChatConfig()).compactAtTokens).toBe(200_000);
  });

  it("saves and reads back the budget", async () => {
    const saved = await saveChatConfig({
      maxSteps: 40,
      maxOutputTokens: 8000,
      compactAtTokens: 120_000,
    });
    expect(saved).toEqual({ maxSteps: 40, maxOutputTokens: 8000, compactAtTokens: 120_000 });
    expect(await getChatConfig()).toEqual(saved);
  });

  // Null is a value here, not an absent field: it means "leave the provider's
  // own limit alone", which is not the same as "fall back to a default cap".
  it("keeps an explicit null output cap", async () => {
    await saveChatConfig({ maxSteps: 40, maxOutputTokens: 8000, compactAtTokens: 200_000 });
    expect(
      await saveChatConfig({ maxSteps: 40, maxOutputTokens: null, compactAtTokens: 200_000 }),
    ).toEqual({ maxSteps: 40, maxOutputTokens: null, compactAtTokens: 200_000 });
  });

  it("leaves the other sections of the settings file alone", async () => {
    await withSection<{ keep: boolean }, void>("voiceConfig", () => ({
      next: { keep: true },
      result: undefined,
    }));
    await saveChatConfig({ maxSteps: 12, maxOutputTokens: null, compactAtTokens: 200_000 });
    expect(await readSection<{ keep: boolean }>("voiceConfig")).toEqual({ keep: true });
  });

  describe("getChatBudget", () => {
    it("uses the model's own threshold over the global one", async () => {
      await saveChatConfig({ maxSteps: 40, maxOutputTokens: null, compactAtTokens: 300_000 });
      const budget = await getChatBudget(appConfig, "anthropic", "claude-haiku-4-5");
      expect(budget.compactAtTokens).toBe(150_000);
      expect(budget.maxSteps).toBe(40);
    });

    it("falls back to the global threshold for a model with none", async () => {
      await saveChatConfig({ maxSteps: 40, maxOutputTokens: null, compactAtTokens: 300_000 });
      await saveProviderModel({
        providerId: "anthropic",
        modelId: "custom-model",
        capabilities: ["chat"],
      });
      const budget = await getChatBudget(appConfig, "anthropic", "custom-model");
      expect(budget.compactAtTokens).toBe(300_000);
    });
  });
});
