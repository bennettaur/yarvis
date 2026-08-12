import { ensureOk, sidecarFetch } from "./api";

/**
 * Speech-to-text / text-to-speech client. The chat half of the voice loop goes
 * through `lib/chat.ts` as usual — only the speech calls live here.
 */

/** Built-ins use their bare name; user-configured proxies are `custom:<id>`. */
export type VoiceProviderId = string;

export interface VoiceProviderInfo {
  id: VoiceProviderId;
  label: string;
  available: boolean;
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
export async function speak({ provider, model, text, voice }: SpeakRequest): Promise<Blob> {
  const res = await sidecarFetch("/api/voice/speak", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider, model, text, voice }),
  });
  await ensureOk(res, "speak");
  return res.blob();
}
