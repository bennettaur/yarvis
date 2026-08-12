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
  /**
   * ISO-639-1 hint for transcription, e.g. "en". Blank lets the model detect
   * the language, which is the right default but measurably worse at picking
   * out a short utterance in a noisy room.
   */
  sttLanguage: string;
  ttsProvider: string;
  ttsModel: string;
  /** Provider-specific voice id; blank means the provider's default. */
  ttsVoice: string;
  /**
   * Reference clip for a voice-cloning model, as a base64 audio data URI. Some
   * servers (MOSS-TTS-Nano) take one instead of a voice id and refuse a request
   * without it.
   */
  ttsRefAudio: string;
  /**
   * Extra JSON fields merged into each synthesis request, as typed by the user.
   * Kept as raw text rather than parsed so a half-finished edit survives a
   * re-render; it is parsed at call time and a syntax error is reported then.
   */
  ttsExtraBody: string;
  speakReplies: boolean;
  /**
   * Ends a turn on silence and re-opens the mic once the reply finishes, so a
   * conversation runs without touching the keyboard. Off means push-to-talk.
   *
   * Off by default, and deliberately: with it on, anything audible in the room
   * can become a turn the user never addressed to the assistant. Turning it on
   * should be a choice made about a particular room.
   */
  handsFree: boolean;
}

export const VOICE_SETTINGS_KEY = "yarvis.voice.settings";

export const DEFAULT_VOICE_SETTINGS: VoiceSettings = {
  llmProvider: "",
  llmModel: "",
  sttProvider: "",
  sttModel: "",
  sttLanguage: "",
  ttsProvider: "",
  ttsModel: "",
  ttsVoice: "",
  ttsRefAudio: "",
  ttsExtraBody: "",
  speakReplies: true,
  handsFree: false,
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
    sttLanguage: stringField(raw.sttLanguage, DEFAULT_VOICE_SETTINGS.sttLanguage),
    ttsProvider: stringField(raw.ttsProvider, DEFAULT_VOICE_SETTINGS.ttsProvider),
    ttsModel: stringField(raw.ttsModel, DEFAULT_VOICE_SETTINGS.ttsModel),
    ttsVoice: stringField(raw.ttsVoice, DEFAULT_VOICE_SETTINGS.ttsVoice),
    ttsRefAudio: stringField(raw.ttsRefAudio, DEFAULT_VOICE_SETTINGS.ttsRefAudio),
    ttsExtraBody: stringField(raw.ttsExtraBody, DEFAULT_VOICE_SETTINGS.ttsExtraBody),
    speakReplies: boolField(raw.speakReplies, DEFAULT_VOICE_SETTINGS.speakReplies),
    handsFree: boolField(raw.handsFree, DEFAULT_VOICE_SETTINGS.handsFree),
  };
}

export function saveVoiceSettings(settings: VoiceSettings): void {
  localStorage.setItem(VOICE_SETTINGS_KEY, JSON.stringify(settings));
}

/**
 * Parses the user's extra-fields JSON. Throws a message worth showing rather
 * than a raw `SyntaxError`, since this is a field someone types into by hand.
 * Blank means none.
 */
export function parseTtsExtras(raw: string): Record<string, string | number | boolean> | undefined {
  const text = raw.trim();
  if (!text) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('Extra TTS fields must be valid JSON, e.g. {"response_format": "wav"}');
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Extra TTS fields must be a JSON object");
  }
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(parsed)) {
    // The sidecar refuses nested values anyway; saying so here points at the
    // field the user can actually see.
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new Error(`Extra TTS field "${key}" must be a string, number or boolean`);
    }
    out[key] = value;
  }
  return out;
}

/**
 * The synthesis arguments implied by the current settings, shared by the voice
 * loop and the settings bar's test button so the two can't drift.
 */
export function ttsRequestFrom(
  settings: VoiceSettings,
  text: string,
): {
  provider: string;
  model: string;
  text: string;
  voice?: string;
  refAudio?: string;
  extras?: Record<string, string | number | boolean>;
} {
  return {
    provider: settings.ttsProvider,
    model: settings.ttsModel,
    text,
    voice: settings.ttsVoice || undefined,
    refAudio: settings.ttsRefAudio || undefined,
    extras: parseTtsExtras(settings.ttsExtraBody),
  };
}

/**
 * Fills in whatever the user hasn't chosen from the catalogs, and drops a
 * selection the app can no longer use — one whose provider is gone, or whose
 * provider is listed but has no key. Either would fail every request with
 * nothing on screen explaining why, so the picker moves to something that
 * works instead. A model the catalog doesn't list is kept: the suggestions are
 * not the full set of what a backend serves.
 */
export function withVoiceDefaults(
  settings: VoiceSettings,
  llmProviders: ProviderInfo[],
  voiceProviders: VoiceProviderInfo[],
): VoiceSettings {
  const usable = <T extends { id: string; available: boolean }>(
    providers: T[],
    savedId: string,
    extra: (provider: T) => boolean = () => true,
  ): T | undefined => {
    const saved = providers.find((p) => p.id === savedId);
    if (saved?.available && extra(saved)) return saved;
    return providers.find((p) => p.available && extra(p));
  };

  const llm = usable(llmProviders, settings.llmProvider, (p) => p.models.length > 0);
  // A provider that can't do the half it was chosen for is dropped the same way
  // an unconfigured one is: it would fail every request with nothing on screen
  // to explain why. This is what moves an older saved Hugging Face TTS choice
  // off a backend whose router refuses every speech model.
  const stt = usable(voiceProviders, settings.sttProvider, (p) => p.capabilities.includes("stt"));
  const tts = usable(voiceProviders, settings.ttsProvider, (p) => p.capabilities.includes("tts"));

  /**
   * A saved model survives only when the provider it belongs to is the one
   * still resolved — a model name means nothing to a different backend. Returns
   * "" otherwise, so the caller falls back to the new provider's first
   * suggestion.
   */
  const keepModelIfProviderUnchanged = (
    savedModel: string,
    resolvedProvider: { id: string } | undefined,
    savedProviderId: string,
  ) => (savedModel && resolvedProvider?.id === savedProviderId ? savedModel : "");

  return {
    ...settings,
    llmProvider: llm?.id ?? "",
    llmModel:
      keepModelIfProviderUnchanged(settings.llmModel, llm, settings.llmProvider) ||
      (llm?.models[0] ?? ""),
    sttProvider: stt?.id ?? "",
    sttModel:
      keepModelIfProviderUnchanged(settings.sttModel, stt, settings.sttProvider) ||
      (stt?.sttModels[0] ?? ""),
    ttsProvider: tts?.id ?? "",
    ttsModel:
      keepModelIfProviderUnchanged(settings.ttsModel, tts, settings.ttsProvider) ||
      (tts?.ttsModels[0] ?? ""),
  };
}
