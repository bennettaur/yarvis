import { ensureOk, sidecarFetch } from "./api";

/**
 * Speech-to-text / text-to-speech client. The chat half of the voice loop goes
 * through `lib/chat.ts` as usual — only the speech calls live here.
 */

/** Built-ins use their bare name; user-configured proxies are `custom:<id>`. */
export type VoiceProviderId = string;

/** Which half of the voice loop a provider can serve. */
export type SpeechCapability = "stt" | "tts";

export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  available: boolean;
  /** What this backend can do; Hugging Face transcribes but cannot speak. */
  capabilities: SpeechCapability[];
  /** Suggested models. Any model the backend serves may be named instead. */
  sttModels: string[];
  ttsModels: string[];
  custom?: boolean;
}

export interface TranscribeRequest {
  provider: VoiceProviderId;
  model: string;
  audio: Blob;
  /** ISO-639-1 hint, e.g. "en". */
  language?: string;
}

export interface SpeakRequest {
  provider: VoiceProviderId;
  model: string;
  text: string;
  voice?: string;
  /**
   * Reference clip for a voice-cloning model, as a base64 audio data URI. Sent
   * as `ref_audio`; MOSS-TTS-Nano and similar require it on every call.
   */
  refAudio?: string;
  /** Server-specific body fields, merged into the request as-is. */
  extras?: Record<string, string | number | boolean>;
}

export async function listVoiceProviders(): Promise<VoiceProviderInfo[]> {
  const res = await sidecarFetch("/api/voice/providers");
  await ensureOk(res, "voice providers");
  return res.json();
}

export async function transcribe({
  provider,
  model,
  audio,
  language,
}: TranscribeRequest): Promise<string> {
  const params = new URLSearchParams({ provider, model });
  if (language) params.set("language", language);
  const res = await sidecarFetch(`/api/voice/transcribe?${params}`, {
    method: "POST",
    // The recorder's own MIME type; the sidecar passes it to the provider so
    // the container is identified without re-encoding.
    headers: { "Content-Type": audio.type || "audio/webm" },
    body: audio,
  });
  await ensureOk(res, "transcribe");
  const body = (await res.json()) as { text: string };
  return body.text;
}

/** Synthesizes one chunk of speech, returning audio ready to hand to an `Audio`. */
export async function speak({
  provider,
  model,
  text,
  voice,
  refAudio,
  extras,
}: SpeakRequest): Promise<Blob> {
  const res = await sidecarFetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, text, voice, refAudio, extras }),
  });
  await ensureOk(res, "speak");
  return res.blob();
}
