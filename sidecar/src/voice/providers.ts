import type { Config } from "../config.ts";
import { listCustomProviders } from "../customProviders/service.ts";
import type { Db } from "../db/client.ts";
import type { CustomProviderRow } from "../db/schema.ts";
import { CUSTOM_PROVIDER_PREFIX } from "../llm/providers.ts";
import { HuggingFaceSpeech, OpenAICompatibleSpeech, type SpeechClient } from "./speech.ts";

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

export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  available: boolean;
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

const HUGGINGFACE_STT_MODELS = [
  "openai/whisper-large-v3-turbo",
  "openai/whisper-large-v3",
  "distil-whisper/distil-large-v3",
];

const HUGGINGFACE_TTS_MODELS = [
  "hexgrad/Kokoro-82M",
  "facebook/mms-tts-eng",
  "espnet/kan-bayashi_ljspeech_vits",
];

/**
 * A custom provider can serve speech only if it speaks the OpenAI audio API;
 * the Anthropic wire protocol has no audio endpoints.
 */
function servesSpeech(row: CustomProviderRow): boolean {
  return row.apiKind === "openai" || row.apiKind === "openai-chat";
}

function customVoiceProviderInfo(row: CustomProviderRow): VoiceProviderInfo {
  return {
    id: `${CUSTOM_PROVIDER_PREFIX}${row.id}`,
    label: row.name,
    available: true,
    // Its configured models are chat models; audio model names are the
    // server's own, so the user names them per request.
    sttModels: [],
    ttsModels: [],
    custom: true,
  };
}

/** Lists speech providers and whether each is usable. */
export async function availableVoiceProviders(
  config: Config,
  db?: Db,
): Promise<VoiceProviderInfo[]> {
  const built: VoiceProviderInfo[] = [
    {
      id: "huggingface",
      label: "Hugging Face",
      available: config.secrets.huggingFaceApiKey !== undefined,
      sttModels: HUGGINGFACE_STT_MODELS,
      ttsModels: HUGGINGFACE_TTS_MODELS,
    },
  ];
  if (!db) return built;
  const rows = await listCustomProviders(db);
  return [...built, ...rows.filter(servesSpeech).map(customVoiceProviderInfo)];
}

/** Resolves the client that talks to a speech provider, or throws if it can't. */
export async function resolveSpeechClient(
  config: Config,
  db: Db | undefined,
  providerId: VoiceProviderId,
): Promise<SpeechClient> {
  if (providerId.startsWith(CUSTOM_PROVIDER_PREFIX)) {
    if (!db) throw new Error("custom providers require a configured database");
    const id = providerId.slice(CUSTOM_PROVIDER_PREFIX.length);
    const rows = await listCustomProviders(db);
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

  throw new Error(`unknown voice provider: ${providerId}`);
}
