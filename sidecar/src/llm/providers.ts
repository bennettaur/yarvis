import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";
import type { Config } from "../config.ts";

export type ProviderId = "anthropic" | "bedrock" | "gemini";

export interface ProviderInfo {
  id: ProviderId;
  label: string;
  models: string[];
  available: boolean;
}

// Default model lists. These IDs may need adjusting per account / region /
// model availability; the chat request can specify any model string.
const ANTHROPIC_MODELS = ["claude-opus-4-7", "claude-sonnet-4-6", "claude-haiku-4-5"];
const BEDROCK_MODELS = ["anthropic.claude-sonnet-4-6-v1:0"];
const GEMINI_MODELS = ["gemini-2.5-flash", "gemini-2.5-pro"];

/** Lists providers and whether each is usable given configured credentials. */
export function availableProviders(config: Config): ProviderInfo[] {
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

/** Resolves a concrete language model for the given provider/model. */
export function resolveModel(
  config: Config,
  providerId: ProviderId,
  modelId: string,
): LanguageModel {
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
  }
}
