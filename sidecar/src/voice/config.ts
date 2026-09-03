import { readSection, withSection } from "../settings/store.ts";
import type { SynthesisExtras } from "./speech.ts";

/**
 * Singleton store for the speech settings, kept as one plain object under the
 * `voiceConfig` key in `~/.yarvis/settings.json`.
 */

export interface VoiceConfigInput {
  sttProvider: string;
  sttModel: string;
  sttLanguage: string;
  ttsProvider: string;
  ttsModel: string;
  ttsVoice: string;
  ttsRefAudio: string;
  ttsExtras: SynthesisExtras;
  speakReplies: boolean;
  handsFree: boolean;
}

/**
 * What every surface sees before anything is configured. Blank providers mean
 * "not set up", which the UI reports rather than failing a request over.
 */
export const DEFAULT_VOICE_CONFIG: VoiceConfigInput = {
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

const SETTINGS_KEY = "voiceConfig";

/** Returns the stored settings merged onto the defaults, or the defaults verbatim when none have been saved. */
export async function getVoiceConfig(): Promise<VoiceConfigInput> {
  const stored = await readSection<Partial<VoiceConfigInput>>(SETTINGS_KEY);
  return { ...DEFAULT_VOICE_CONFIG, ...stored };
}

/** Merges `input` onto the existing stored config (or the defaults) and writes the whole result back. */
export async function saveVoiceConfig(input: Partial<VoiceConfigInput>): Promise<VoiceConfigInput> {
  return withSection<Partial<VoiceConfigInput>, VoiceConfigInput>(SETTINGS_KEY, (current) => {
    const next = { ...DEFAULT_VOICE_CONFIG, ...current, ...input };
    return { next, result: next };
  });
}
