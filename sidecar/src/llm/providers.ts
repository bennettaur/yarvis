import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type { Config } from "../config.ts";
import { listCustomProviders } from "../customProviders/service.ts";
import type { Db } from "../db/client.ts";
import type { CustomProviderRow } from "../db/schema.ts";
import { validateOutboundUrl } from "../lib/urlSafety.ts";

/**
 * Provider identifiers.
 *
 * Built-in providers use their bare name (`anthropic`, `bedrock`, `gemini`).
 * User-configured proxies are namespaced as `custom:<provider-id>` so they
 * never collide with the built-in ids.
 */
export type ProviderId = string;

export const CUSTOM_PROVIDER_PREFIX = "custom:";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: string[];
  available: boolean;
  /** True for user-configured providers; helps the UI render them distinctly. */
  custom?: boolean;
}

// Default model lists. These IDs may need adjusting per account / region /
// model availability; the chat request can specify any model string.
const ANTHROPIC_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];
const BEDROCK_MODELS = ["anthropic.claude-sonnet-4-6-v1:0"];
const GEMINI_MODELS = [
  "gemini-3.5-flash",
  "gemini-3-flash-preview",
  "gemini-3.1-flash-lite",
  "gemini-3.1-pro-preview",
];

function builtInProviders(config: Config): ProviderInfo[] {
  return [
    {
      id: "anthropic",
      label: "Anthropic",
      models: ANTHROPIC_MODELS,
      available: config.secrets.anthropicApiKey !== undefined,
    },
    {
      // Bedrock uses the standard AWS credential chain, so we can't cheaply
      // detect availability here; assume reachable and surface errors at call time.
      id: "bedrock",
      label: "AWS Bedrock",
      models: BEDROCK_MODELS,
      available: true,
    },
    {
      id: "gemini",
      label: "Gemini",
      models: GEMINI_MODELS,
      available: config.secrets.geminiApiKey !== undefined,
    },
  ];
}

function customProviderInfo(row: CustomProviderRow): ProviderInfo {
  return {
    id: `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
    label: row.name,
    models: row.models,
    // A custom provider is usable once it has at least one configured model.
    // The proxy may or may not require an api key, so we don't gate on secrets.
    available: row.models.length > 0,
    custom: true,
  };
}

/**
 * Lists providers and whether each is usable. When a `db` is provided, the
 * user's configured custom providers are appended.
 */
export async function availableProviders(config: Config, db?: Db): Promise<ProviderInfo[]> {
  const built = builtInProviders(config);
  if (!db) return built;
  const rows = await listCustomProviders(db);
  return [...built, ...rows.map(customProviderInfo)];
}

function resolveCustom(row: CustomProviderRow, config: Config, modelId: string): LanguageModel {
  // Defense-in-depth: the create/update routes already validate, but DB rows
  // can have been seeded by an earlier version, so re-check at resolve time.
  validateOutboundUrl(row.baseUrl);
  const secrets = config.customProviderSecrets[row.id] ?? { headers: {} };
  const options = {
    baseURL: row.baseUrl,
    apiKey: secrets.apiKey,
    headers: secrets.headers,
  };
  switch (row.apiKind) {
    case "openai":
      // Default call goes through the OpenAI Responses API.
      return createOpenAI(options)(modelId);
    case "openai-chat":
      // Use the legacy /chat/completions endpoint for gateways (e.g. older
      // litellm versions) that don't speak the Responses API.
      return createOpenAI(options).chat(modelId);
    case "anthropic":
      return createAnthropic(options)(modelId);
    default:
      throw new Error(`unsupported apiKind: ${row.apiKind}`);
  }
}

/** Resolves a concrete language model for the given provider/model. */
export async function resolveModel(
  config: Config,
  db: Db | undefined,
  providerId: ProviderId,
  modelId: string,
): Promise<LanguageModel> {
  if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    if (!db) throw new Error("custom providers require a configured database");
    const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
    const rows = await listCustomProviders(db);
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`unknown custom provider: ${id}`);
    return resolveCustom(row, config, modelId);
  }

  switch (providerId) {
    case "anthropic": {
      const apiKey = config.secrets.anthropicApiKey;
      if (!apiKey) throw new Error("Anthropic API key not configured");
      return createAnthropic({ apiKey })(modelId);
    }
    case "gemini": {
      const apiKey = config.secrets.geminiApiKey;
      if (!apiKey) throw new Error("Gemini API key not configured");
      return createGoogleGenerativeAI({ apiKey })(modelId);
    }
    case "bedrock": {
      return createAmazonBedrock({
        region: process.env.AWS_REGION ?? "us-east-1",
      })(modelId);
    }
    default:
      throw new Error(`unknown provider: ${providerId}`);
  }
}
