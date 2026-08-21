import { and, asc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type ProviderModelRow, providerModels } from "../db/schema.ts";

/**
 * What every surface draws its model list from.
 *
 * A model is not interchangeable with every other model its provider serves: a
 * TTS model has no chat completion to give, and a Whisper checkpoint has no
 * opinion about tool calls. Each entry therefore carries what it can do, and
 * the pickers filter on that instead of offering one flat list everywhere.
 *
 * The bundled lists below are only defaults. Rows in `provider_models` take
 * over a provider's catalogue the moment the user saves one, so a model
 * released after this build — or one this account has no access to — is a
 * settings edit rather than a release.
 */

/**
 * What a model can be asked to do.
 *
 * `stt` covers any model that turns audio into text, whether that is a
 * dedicated ASR checkpoint or a multimodal chat model handed an audio part;
 * from a caller's side they are the same capability.
 */
export const MODEL_CAPABILITIES = ["chat", "stt", "tts", "vision", "embed"] as const;

export type ModelCapability = (typeof MODEL_CAPABILITIES)[number];

export interface ModelInfo {
  id: string;
  capabilities: ModelCapability[];
}

export function isModelCapability(value: string): value is ModelCapability {
  return (MODEL_CAPABILITIES as readonly string[]).includes(value);
}

/** Shorthand for the common case of a text-in/text-out chat model. */
const chat = (id: string, ...extra: ModelCapability[]): ModelInfo => ({
  id,
  capabilities: ["chat", ...extra],
});

/**
 * Default catalogue per built-in provider, keyed by `ProviderInfo.id`.
 *
 * Gemini's chat models are tagged `stt` because the same endpoint transcribes
 * an audio part, which is how `GeminiSpeech` implements speech-to-text — there
 * is no separate ASR model to name. Its `-tts` models are the reverse: audio
 * out only, and deliberately not tagged `chat` so they can't be picked to
 * answer with.
 */
export const DEFAULT_MODELS: Record<string, ModelInfo[]> = {
  anthropic: [
    chat("claude-opus-4-7", "vision"),
    chat("claude-sonnet-4-6", "vision"),
    chat("claude-haiku-4-5", "vision"),
  ],
  bedrock: [chat("anthropic.claude-sonnet-4-6-v1:0", "vision")],
  gemini: [
    chat("gemini-3.5-flash", "vision", "stt"),
    chat("gemini-3-flash-preview", "vision", "stt"),
    chat("gemini-3.1-flash-lite", "vision", "stt"),
    chat("gemini-3.1-pro-preview", "vision", "stt"),
    { id: "gemini-2.5-flash-preview-tts", capabilities: ["tts"] },
    { id: "gemini-2.5-pro-preview-tts", capabilities: ["tts"] },
  ],
  cerebras: [
    chat("zai-glm-4.6"),
    chat("qwen-3-coder-480b"),
    chat("gpt-oss-120b"),
    chat("llama-3.3-70b"),
  ],
  /**
   * Transcription only. The obvious TTS candidates — `hexgrad/Kokoro-82M`,
   * `facebook/mms-tts-eng` — are refused by the serverless router with "Model
   * not supported by provider hf-inference", so listing one would only make a
   * dead configuration look like the default.
   */
  huggingface: [
    { id: "openai/whisper-large-v3-turbo", capabilities: ["stt"] },
    { id: "openai/whisper-large-v3", capabilities: ["stt"] },
    { id: "distil-whisper/distil-large-v3", capabilities: ["stt"] },
  ],
};

/** The bundled defaults for a provider, or an empty list for one with none. */
export function defaultModels(providerId: string): ModelInfo[] {
  return DEFAULT_MODELS[providerId] ?? [];
}

export interface ProviderModelInput {
  providerId: string;
  modelId: string;
  capabilities: ModelCapability[];
  enabled?: boolean;
  sortOrder?: number;
}

function rowToInfo(row: ProviderModelRow): ModelInfo {
  return {
    id: row.modelId,
    // Rows predate no capability the code knows about today, but a row written
    // by a newer build could; drop what this build can't act on rather than
    // handing a picker a tag it will never match.
    capabilities: row.capabilities.filter(isModelCapability),
  };
}

/** Every configured row, in the order the pickers should show them. */
export async function listProviderModels(db: Db): Promise<ProviderModelRow[]> {
  return db
    .select()
    .from(providerModels)
    .orderBy(
      asc(providerModels.providerId),
      asc(providerModels.sortOrder),
      asc(providerModels.modelId),
    );
}

/**
 * Upserts one model. Keyed on (provider, model) rather than the row id so the
 * settings UI can save a model without first looking up whether it exists.
 */
export async function saveProviderModel(
  db: Db,
  input: ProviderModelInput,
): Promise<ProviderModelRow> {
  const [row] = await db
    .insert(providerModels)
    .values(input)
    .onConflictDoUpdate({
      target: [providerModels.providerId, providerModels.modelId],
      set: {
        capabilities: input.capabilities,
        enabled: input.enabled ?? true,
        sortOrder: input.sortOrder ?? 0,
        updatedAt: new Date(),
      },
    })
    .returning();
  return row!;
}

export async function deleteProviderModel(
  db: Db,
  providerId: string,
  modelId: string,
): Promise<boolean> {
  const rows = await db
    .delete(providerModels)
    .where(and(eq(providerModels.providerId, providerId), eq(providerModels.modelId, modelId)))
    .returning({ id: providerModels.id });
  return rows.length > 0;
}

/** Drops every row for a provider, returning it to the bundled defaults. */
export async function resetProviderModels(db: Db, providerId: string): Promise<number> {
  const rows = await db
    .delete(providerModels)
    .where(eq(providerModels.providerId, providerId))
    .returning({ id: providerModels.id });
  return rows.length;
}

/**
 * The catalogue a provider should offer: its configured rows when it has any,
 * otherwise `fallback`.
 *
 * Configured rows replace the defaults wholesale rather than merging with them.
 * Merging would make a bundled model impossible to remove — the case that
 * matters most, since an id this build ships is exactly what a user without
 * access to it needs gone.
 */
export function catalogFor(
  providerId: string,
  rows: ProviderModelRow[],
  fallback: ModelInfo[] = defaultModels(providerId),
): ModelInfo[] {
  const mine = rows.filter((r) => r.providerId === providerId);
  if (mine.length === 0) return fallback;
  return mine.filter((r) => r.enabled).map(rowToInfo);
}

/** Narrows a catalogue to the models that can serve `capability`. */
export function withCapability(models: ModelInfo[], capability: ModelCapability): ModelInfo[] {
  return models.filter((m) => m.capabilities.includes(capability));
}
