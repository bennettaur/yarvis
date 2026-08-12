import type { ProviderInfo } from "./chat";
import type { VoiceProviderInfo } from "./voice";

/**
 * The voice loop's own provider/model selection, kept separate from the Chat
 * tab's so the two can run on different models — a local Gemma answering by
 * voice while chat stays on a hosted model, say. Stored in localStorage like
 * the chat picker, since it is a per-machine UI preference rather than data.
 */

export interface VoiceSettings {
  /** The model that answers; ids come from the shared LLM provider catalog. */
  llmProvider: string;
  llmModel: string;
  sttProvider: string;
  sttModel: string;
  ttsProvider: string;
  ttsModel: string;
  /** Provider-specific voice id; blank means the provider's default. */
  ttsVoice: string;
  speakReplies: boolean;
  /**
   * Ends a turn on silence and re-opens the mic once the reply finishes, so a
   * conversation runs without touching the keyboard. Off means push-to-talk.
   */
  handsFree: boolean;
}

export const VOICE_SETTINGS_KEY = "yarvis.voice.settings";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  llmProvider: "",
  llmModel: "",
  sttProvider: "",
  sttModel: "",
  ttsProvider: "",
  ttsModel: "",
  ttsVoice: "",
  speakReplies: true,
  handsFree: true,
};

function stringField(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function boolField(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Reads the saved settings, ignoring anything malformed field by field. */
export function loadVoiceSettings(): VoiceSettings {
  let saved: unknown;
  try {
    saved = JSON.parse(localStorage.getItem(VOICE_SETTINGS_KEY) ?? "null");
  } catch {
    return { ...DEFAULT_VOICE_SETTINGS };
  }
  if (!saved || typeof saved !== "object") return { ...DEFAULT_VOICE_SETTINGS };
  const raw = saved as Record<string, unknown>;
  return {
    llmProvider: stringField(raw.llmProvider, DEFAULT_VOICE_SETTINGS.llmProvider),
    llmModel: stringField(raw.llmModel, DEFAULT_VOICE_SETTINGS.llmModel),
    sttProvider: stringField(raw.sttProvider, DEFAULT_VOICE_SETTINGS.sttProvider),
    sttModel: stringField(raw.sttModel, DEFAULT_VOICE_SETTINGS.sttModel),
    ttsProvider: stringField(raw.ttsProvider, DEFAULT_VOICE_SETTINGS.ttsProvider),
    ttsModel: stringField(raw.ttsModel, DEFAULT_VOICE_SETTINGS.ttsModel),
    ttsVoice: stringField(raw.ttsVoice, DEFAULT_VOICE_SETTINGS.ttsVoice),
    speakReplies: boolField(raw.speakReplies, DEFAULT_VOICE_SETTINGS.speakReplies),
    handsFree: boolField(raw.handsFree, DEFAULT_VOICE_SETTINGS.handsFree),
  };
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Fills in whatever the user hasn't chosen from the catalogs, and drops a
 * selection whose provider is no longer configured — a stale provider id would
 * otherwise fail every request with no visible reason. A model the catalog
 * doesn't list is kept: the suggestions are not the full set of what a backend
 * serves.
 */
export function withVoiceDefaults(
  settings: VoiceSettings,
  llmProviders: ProviderInfo[],
  voiceProviders: VoiceProviderInfo[],
): VoiceSettings {
  const llm =
    llmProviders.find((p) => p.id === settings.llmProvider) ??
    llmProviders.find((p) => p.available && p.models.length > 0);
  const stt =
    voiceProviders.find((p) => p.id === settings.sttProvider) ??
    voiceProviders.find((p) => p.available);
  const tts =
    voiceProviders.find((p) => p.id === settings.ttsProvider) ??
    voiceProviders.find((p) => p.available);

  const keepModel = (model: string, provider: { id: string } | undefined, chosen: string) =>
    model && provider?.id === chosen ? model : "";

  return {
    ...settings,
    llmProvider: llm?.id ?? "",
    llmModel: keepModel(settings.llmModel, llm, settings.llmProvider) || (llm?.models[0] ?? ""),
    sttProvider: stt?.id ?? "",
    sttModel: keepModel(settings.sttModel, stt, settings.sttProvider) || (stt?.sttModels[0] ?? ""),
    ttsProvider: tts?.id ?? "",
    ttsModel: keepModel(settings.ttsModel, tts, settings.ttsProvider) || (tts?.ttsModels[0] ?? ""),
  };
}
