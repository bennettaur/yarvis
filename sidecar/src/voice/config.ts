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
  /**
   * Keep the microphone open and send each turn when the turn detector judges
   * it finished (`voice/turnDetector.ts`).
   */
  continuous: boolean;
  /**
   * A saved voice (`voice/profiles.ts`) that replies are spoken in. Blank uses
   * the `tts*` fields above, so a setup from before saved voices keeps working.
   */
  activeVoiceId: string;
  /** Chat model the Voice Studio translates with. Blank until the user picks one. */
  translationProvider: string;
  translationModel: string;
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
  continuous: false,
  activeVoiceId: "",
  translationProvider: "",
  translationModel: "",
};

const SETTINGS_KEY = "voiceConfig";

/** Returns the stored settings merged onto the defaults, or the defaults verbatim when none have been saved. */
export async function getVoiceConfig(): Promise<VoiceConfigInput> {
  const stored = await readSection<Partial<VoiceConfigInput>>(SETTINGS_KEY);
  return withoutRetiredKeys({ ...DEFAULT_VOICE_CONFIG, ...stored });
}

/**
 * Drops `handsFree`, which continuous mode replaced. Its value isn't carried
 * over: continuous mode listens while the reply plays too, which is more than
 * anyone who turned hands-free on agreed to.
 */
function withoutRetiredKeys(config: VoiceConfigInput & { handsFree?: unknown }): VoiceConfigInput {
  const { handsFree: _, ...rest } = config;
  return rest;
}

/** Merges `input` onto the existing stored config (or the defaults) and writes the whole result back. */
export async function saveVoiceConfig(input: Partial<VoiceConfigInput>): Promise<VoiceConfigInput> {
  return withSection<Partial<VoiceConfigInput>, VoiceConfigInput>(SETTINGS_KEY, (current) => {
    const next = withoutRetiredKeys({ ...DEFAULT_VOICE_CONFIG, ...current, ...input });
    return { next, result: next };
  });
}
