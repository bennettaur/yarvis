import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import { createOpenAI } from "@ai-sdk/openai";
import type { JSONValue, LanguageModel } from "ai";
import type { Config } from "../config.ts";
import { type CustomProviderRow, listCustomProviders } from "../customProviders/service.ts";
import { validateOutboundUrl } from "../lib/urlSafety.ts";
import {
  catalogFor,
  listProviderModels,
  type ModelCapability,
  type ModelInfo,
  type ProviderModelRow,
  withCapability,
} from "./catalog.ts";

/**
 * Provider identifiers.
 *
 * Built-in providers use their bare name (`anthropic`, `bedrock`, `gemini`,
 * `cerebras`).
 * User-configured proxies are namespaced as `custom:<provider-id>` so they
 * never collide with the built-in ids.
 */
export type ProviderId = string;

export const CUSTOM_PROVIDER_PREFIX = "custom:";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  /**
   * What this provider serves, each entry tagged with what it can do. Not every
   * model is a chat model — a TTS model belongs to the same provider but has no
   * completion to give — so callers narrow this by capability rather than
   * offering it whole.
   */
  models: ModelInfo[];
  available: boolean;
  /** True for user-configured providers; helps the UI render them distinctly. */
  custom?: boolean;
}

const CEREBRAS_BASE_URL = "https://api.cerebras.ai/v1";

function builtInProviders(config: Config, rows: ProviderModelRow[]): ProviderInfo[] {
  return [
    {
      id: "anthropic",
      label: "Anthropic",
      models: catalogFor("anthropic", rows),
      available: config.secrets.anthropicApiKey !== undefined,
    },
    {
      // Bedrock uses the standard AWS credential chain, so we can't cheaply
      // detect availability here; assume reachable and surface errors at call time.
      id: "bedrock",
      label: "AWS Bedrock",
      models: catalogFor("bedrock", rows),
      available: true,
    },
    {
      id: "gemini",
      label: "Gemini",
      models: catalogFor("gemini", rows),
      available: config.secrets.geminiApiKey !== undefined,
    },
    {
      id: "cerebras",
      label: "Cerebras",
      models: catalogFor("cerebras", rows),
      available: config.secrets.cerebrasApiKey !== undefined,
    },
  ];
}

/**
 * A custom provider's own `models` column is its default catalogue. Those ids
 * were entered as chat models — that is the only thing the provider form asks
 * for — so they are tagged as such, and a `provider_models` row is how a
 * speech model on the same proxy gets named.
 */
function customProviderInfo(row: CustomProviderRow, rows: ProviderModelRow[]): ProviderInfo {
  const id = `${CUSTOM_PROVIDER_PREFIX}${row.id}`;
  const models = catalogFor(
    id,
    rows,
    row.models.map((m) => ({ id: m, capabilities: ["chat" as const] })),
  );
  return {
    id,
    label: row.name,
    models,
    // A custom provider is usable once it has at least one configured model.
    // The proxy may or may not require an api key, so we don't gate on secrets.
    available: models.length > 0,
    custom: true,
  };
}

/**
 * Lists providers and whether each is usable. The user's configured custom
 * providers are appended and their saved catalogues take over from the
 * bundled defaults — both live in `~/.yarvis/settings.json`, not Postgres, so
 * this needs no database.
 *
 * Passing a `capability` narrows every provider's models to the ones that serve
 * it — what a chat picker wants, so a TTS model never shows up as something to
 * think with. Providers are still returned when nothing of theirs matches, so
 * the caller can tell "no models for this" from "no such provider".
 */
export async function availableProviders(
  config: Config,
  capability?: ModelCapability,
): Promise<ProviderInfo[]> {
  const narrow = (providers: ProviderInfo[]): ProviderInfo[] =>
    capability
      ? providers.map((p) => ({ ...p, models: withCapability(p.models, capability) }))
      : providers;

  const [modelRows, customRows] = await Promise.all([listProviderModels(), listCustomProviders()]);
  return narrow([
    ...builtInProviders(config, modelRows),
    ...customRows.map((row) => customProviderInfo(row, modelRows)),
  ]);
}

/**
 * Picks a sensible default provider/model for callers that have no user
 * selection to draw on (e.g. the Telegram bot, which can't see the frontend's
 * localStorage). Returns the first available provider's first model, or null
 * when nothing is configured. Built-ins are listed before custom providers, so
 * any keyed built-in wins before a proxy.
 */
export async function defaultProviderModel(
  config: Config,
): Promise<{ provider: ProviderId; model: string } | null> {
  return pickDefaultModel(await availableProviders(config, "chat"));
}

/**
 * Chooses a default provider/model from an already-fetched provider list, so
 * callers that already hold the list don't re-query. Returns null when nothing
 * is usable. Bedrock reports `available` unconditionally because its AWS
 * credentials can't be cheaply probed, so it would otherwise win the default
 * even when the user only configured, say, Gemini; prefer any other configured
 * provider and fall back to Bedrock only when it is the sole option.
 */
export function pickDefaultModel(
  providers: ProviderInfo[],
): { provider: ProviderId; model: string } | null {
  const usable = providers.filter(
    (p) => p.available && p.models.some((m) => m.capabilities.includes("chat")),
  );
  if (usable.length === 0) return null;
  const preferred = usable.find((p) => p.id !== "bedrock") ?? usable[0]!;
  return {
    provider: preferred.id,
    model: preferred.models.find((m) => m.capabilities.includes("chat"))!.id,
  };
}

function resolveCustom(row: CustomProviderRow, config: Config, modelId: string): LanguageModel {
  // Defense-in-depth: the create/update routes already validate, but DB rows
  // can have been seeded by an earlier version, so re-check at resolve time.
  // Local providers (e.g. a local Ollama server) legitimately live on loopback.
  validateOutboundUrl(row.baseUrl, { allowLoopback: true });
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
  providerId: ProviderId,
  modelId: string,
): Promise<LanguageModel> {
  if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
    const rows = await listCustomProviders();
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
    case "cerebras": {
      const apiKey = config.secrets.cerebrasApiKey;
      if (!apiKey) throw new Error("Cerebras API key not configured");
      // Cerebras serves /chat/completions but not the Responses API, so this
      // reuses the OpenAI client rather than adding a Cerebras SDK package.
      return createOpenAI({ apiKey, baseURL: CEREBRAS_BASE_URL }).chat(modelId);
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

/**
 * Provider options that ask a model to return its reasoning, for the surfaces
 * that offer to show it. Only providers whose parameter shape we know are asked;
 * anything else is left alone, because a gateway that rejects an unknown field
 * fails the whole turn — and a model that streams reasoning natively is
 * displayed either way, since the reasoning parts arrive regardless.
 *
 * Anthropic takes adaptive thinking with `display: "summarized"`: the default is
 * omitted, which streams empty reasoning blocks and reads as a long pause.
 */
export async function reasoningOptions(
  providerId: ProviderId,
): Promise<Record<string, Record<string, JSONValue>> | undefined> {
  const anthropicThinking = {
    anthropic: { thinking: { type: "adaptive", display: "summarized" } },
  };
  if (providerId === "anthropic" || providerId === "bedrock") return anthropicThinking;
  if (providerId === "gemini") return { google: { thinkingConfig: { includeThoughts: true } } };
  if (!providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) return undefined;

  // A custom provider is a proxy: what it wants is decided by the API it speaks,
  // not by the model name behind it.
  const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
  const row = (await listCustomProviders()).find((r) => r.id === id);
  return row?.apiKind === "anthropic" ? anthropicThinking : undefined;
}
