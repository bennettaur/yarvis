import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Config } from "../config.ts";
import {
  DEFAULT_COMPLEXITY_MODEL_CONFIG,
  getComplexityModelConfig,
  resolveComplexityModel,
  saveComplexityModelConfig,
} from "./complexity.ts";
import { defaultProviderModel } from "./providers.ts";

/**
 * The complexity-tier model settings live in `~/.yarvis/settings.json` for
 * the same reason `voiceConfig` does (see issue #226). These cover the round
 * trip every specialist that opts into a tier depends on.
 */

let dir: string;
let originalPath: string | undefined;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "yarvis-complexity-config-"));
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

describe("complexity model config", () => {
  it("answers all tiers unset before anything is configured", async () => {
    expect(await getComplexityModelConfig()).toEqual(DEFAULT_COMPLEXITY_MODEL_CONFIG);
  });

  it("saves and reads back one tier, leaving the others unset", async () => {
    const saved = await saveComplexityModelConfig({
      low: { provider: "cerebras", model: "llama-3.3-70b" },
    });
    expect(saved).toEqual({
      ...DEFAULT_COMPLEXITY_MODEL_CONFIG,
      low: { provider: "cerebras", model: "llama-3.3-70b" },
    });

    expect(await getComplexityModelConfig()).toEqual(saved);
  });

  it("keeps a single merged object across repeated saves", async () => {
    await saveComplexityModelConfig({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    await saveComplexityModelConfig({
      medium: { provider: "anthropic", model: "claude-haiku-4-5" },
    });

    // A later save must not wipe what an earlier one set.
    const config = await getComplexityModelConfig();
    expect(config.low).toEqual({ provider: "cerebras", model: "llama-3.3-70b" });
    expect(config.medium).toEqual({ provider: "anthropic", model: "claude-haiku-4-5" });
  });

  it("clears a tier by saving it as null", async () => {
    await saveComplexityModelConfig({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    await saveComplexityModelConfig({ low: null });

    expect((await getComplexityModelConfig()).low).toBeNull();
  });
});

describe("resolveComplexityModel", () => {
  it("returns the configured tier's model verbatim", async () => {
    await saveComplexityModelConfig({ low: { provider: "cerebras", model: "llama-3.3-70b" } });
    expect(await resolveComplexityModel(noSecrets, "low")).toEqual({
      provider: "cerebras",
      model: "llama-3.3-70b",
    });
  });

  it("falls back to the default chat model when the tier is unset", async () => {
    // Bedrock's AWS credentials can't be cheaply probed, so it reports
    // available unconditionally and is what `defaultProviderModel` falls back
    // to with no other provider configured — the point being it falls back to
    // *that*, not to a hardcoded model of the tier's own.
    expect(await resolveComplexityModel(noSecrets, "medium")).toEqual(
      await defaultProviderModel(noSecrets),
    );
  });
});
