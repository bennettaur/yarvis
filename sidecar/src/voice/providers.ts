import type { Config } from "../config.ts";
import { type CustomProviderRow, listCustomProviders } from "../customProviders/service.ts";
import {
  catalogFor,
  listProviderModels,
  type ProviderModelRow,
  withCapability,
} from "../llm/catalog.ts";
import { CUSTOM_PROVIDER_PREFIX } from "../llm/providers.ts";
import {
  GeminiSpeech,
  HuggingFaceSpeech,
  OpenAICompatibleSpeech,
  type SpeechClient,
} from "./speech.ts";

/**
 * Which backends can carry the speech halves of the voice loop.
 *
 * The chat half reuses `llm/providers.ts` untouched — the voice surface just
 * holds its own provider/model selection, which is what lets voice run on, say,
 * a local Gemma while chat stays on a hosted model. Only speech needs a
 * registry of its own, and it deliberately mirrors the LLM one: built-ins use a
 * bare id, user-configured proxies keep the `custom:<id>` namespace so the two
 * lists read the same way in the UI.
 */

export type VoiceProviderId = string;

/** Which half of the voice loop a provider can serve. */
export type SpeechCapability = "stt" | "tts";

export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  available: boolean;
  /**
   * What this backend can actually do. Not every provider does both: Hugging
   * Face transcribes but its serverless router refuses every TTS model, so
   * offering it under "Text to speech" only leads somewhere that 400s.
   */
  capabilities: SpeechCapability[];
  /**
   * Model ids known to work, offered as suggestions. Any model string the
   * backend serves is accepted — hosted catalogues change faster than this list
   * and a local server's model names are its own.
   */
  sttModels: string[];
  ttsModels: string[];
  /**
   * True for user-configured providers. Carried to match `ProviderInfo` in
   * `llm/providers.ts` field for field, so the two lists stay interchangeable
   * to a reader; no picker distinguishes on it today.
   */
  custom?: boolean;
}

/**
 * A custom provider can serve speech only if it speaks the OpenAI audio API;
 * the Anthropic wire protocol has no audio endpoints.
 */
function servesSpeech(row: CustomProviderRow): boolean {
  return row.apiKind === "openai" || row.apiKind === "openai-chat";
}

/**
 * Model suggestions for one provider, read from the same catalogue the chat
 * pickers use. Capability tags are what separate the two halves: a `-tts` model
 * has no transcript to give and a Whisper checkpoint has nothing to say, so
 * offering either under the wrong heading only leads somewhere that 400s.
 */
function speechModels(
  providerId: string,
  rows: ProviderModelRow[],
): { sttModels: string[]; ttsModels: string[] } {
  const catalog = catalogFor(providerId, rows);
  return {
    sttModels: withCapability(catalog, "stt").map((m) => m.id),
    ttsModels: withCapability(catalog, "tts").map((m) => m.id),
  };
}

function customVoiceProviderInfo(
  row: CustomProviderRow,
  rows: ProviderModelRow[],
): VoiceProviderInfo {
  const id = `${CUSTOM_PROVIDER_PREFIX}${row.id}`;
  return {
    id,
    label: row.name,
    available: true,
    // An OpenAI-audio server may serve either endpoint or both; which one it
    // implements is only discoverable by asking it, so both are offered.
    capabilities: ["stt", "tts"],
    // Its `models` column holds chat models, so nothing is suggested until the
    // user tags a speech model for it in the catalogue; audio model names are
    // the server's own either way.
    ...speechModels(id, rows),
    custom: true,
  };
}

/** Lists speech providers and whether each is usable. */
export async function availableVoiceProviders(config: Config): Promise<VoiceProviderInfo[]> {
  const [modelRows, customRows] = await Promise.all([listProviderModels(), listCustomProviders()]);

  const built: VoiceProviderInfo[] = [
    {
      id: "huggingface",
      label: "Hugging Face",
      available: config.secrets.huggingFaceApiKey !== undefined,
      // Transcription only: the serverless router refuses every TTS model with
      // "Model not supported by provider hf-inference", so offering it here
      // would only make a dead configuration look like the default.
      capabilities: ["stt"],
      ...speechModels("huggingface", modelRows),
    },
    {
      id: "gemini",
      label: "Gemini",
      available: config.secrets.geminiApiKey !== undefined,
      // Both halves are `generateContent` calls; see `GeminiSpeech`.
      capabilities: ["stt", "tts"],
      ...speechModels("gemini", modelRows),
    },
  ];
  return [
    ...built,
    ...customRows.filter(servesSpeech).map((row) => customVoiceProviderInfo(row, modelRows)),
  ];
}

/** Resolves the client that talks to a speech provider, or throws if it can't. */
export async function resolveSpeechClient(
  config: Config,
  providerId: VoiceProviderId,
): Promise<SpeechClient> {
  if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
    const rows = await listCustomProviders();
    const row = rows.find((r) => r.id === id);
    if (!row) throw new Error(`unknown custom provider: ${id}`);
    if (!servesSpeech(row)) {
      throw new Error(`custom provider ${row.name} does not speak the OpenAI audio API`);
    }
    return new OpenAICompatibleSpeech({
      baseUrl: row.baseUrl,
      secrets: config.customProviderSecrets[row.id],
      // A user-configured speech server on loopback is the case this branch
      // exists for; every other private range stays refused.
      allowLoopback: true,
    });
  }

  if (providerId === "huggingface") {
    const apiKey = config.secrets.huggingFaceApiKey;
    if (!apiKey) throw new Error("Hugging Face API key not configured");
    return new HuggingFaceSpeech(apiKey);
  }

  if (providerId === "gemini") {
    const apiKey = config.secrets.geminiApiKey;
    if (!apiKey) throw new Error("Gemini API key not configured");
    return new GeminiSpeech(apiKey);
  }

  throw new Error(`unknown voice provider: ${providerId}`);
}
