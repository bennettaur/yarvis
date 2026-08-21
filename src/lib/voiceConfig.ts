import { ensureOk, sidecarFetch } from "./api";

/**
 * The speech settings, read from and written to the sidecar.
 *
 * They live server-side rather than in localStorage because they are not a
 * per-window preference: the Telegram bot runs in the sidecar and needs the
 * same providers and models the app uses (issue #226).
 */

export interface VoiceConfig {
  sttProvider: string;
  sttModel: string;
  /** ISO-639-1 hint; blank lets the model detect the language. */
  sttLanguage: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  /** Reference clip for a voice-cloning model, as a base64 audio data URI. */
  ttsRefAudio: string;
  /** Extra body fields for the synthesis request. */
  ttsExtras: Record<string, string | number | boolean>;
  speakReplies: boolean;
  handsFree: boolean;
}

export const DEFAULT_VOICE_CONFIG: VoiceConfig = {
  sttProvider: "",
  sttModel: "",
  sttLanguage: "",
  ttsProvider: "",
  ttsModel: "",
  ttsVoice: "",
  ttsRefAudio: "",
  ttsExtras: {},
  speakReplies: true,
  handsFree: false,
};

export async function getVoiceConfig(): Promise<VoiceConfig> {
  const res = await sidecarFetch("/api/voice/config");
  await ensureOk(res, "voice config");
  return res.json();
}

/** Saves the given fields, leaving the rest as they are. */
export async function saveVoiceConfig(patch: Partial<VoiceConfig>): Promise<VoiceConfig> {
  const res = await sidecarFetch("/api/voice/config", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "save voice config");
  return res.json();
}

/** Whether each half of the loop has enough configuration to be used. */
export function voiceReadiness(config: VoiceConfig): { stt: boolean; tts: boolean } {
  return {
    stt: Boolean(config.sttProvider && config.sttModel),
    tts: Boolean(config.ttsProvider && config.ttsModel),
  };
}

/** The synthesis arguments implied by the config, for one piece of text. */
export function speechRequestFor(config: VoiceConfig, text: string) {
  return {
    provider: config.ttsProvider,
    model: config.ttsModel,
    text,
    voice: config.ttsVoice || undefined,
    refAudio: config.ttsRefAudio || undefined,
    extras: Object.keys(config.ttsExtras).length > 0 ? config.ttsExtras : undefined,
  };
}
