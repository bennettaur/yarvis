import { ensureOk, sidecarFetch } from "./api";

/**
 * Saved voices, the Voice Studio, and the local speech server, all served by
 * the sidecar under `/api/voice`.
 */

export type RefAudioMode = "path" | "inline";

export interface VoiceProfile {
  id: string;
  name: string;
  provider: string;
  model: string;
  voice: string;
  hasClip: boolean;
  /** `path` for mlx-audio, which reads the clip from disk; `inline` for vLLM-Omni. */
  refAudioMode: RefAudioMode;
  extras: Record<string, string | number | boolean>;
  createdAt: string;
  updatedAt: string;
}

export type VoiceProfileInput = Pick<
  VoiceProfile,
  "name" | "provider" | "model" | "voice" | "refAudioMode" | "extras"
>;

const JSON_HEADERS = { "Content-Type": "application/json" };

export async function listVoiceProfiles(): Promise<VoiceProfile[]> {
  const res = await sidecarFetch("/api/voice/voices");
  await ensureOk(res, "voices");
  return res.json();
}

export async function createVoiceProfile(input: VoiceProfileInput): Promise<VoiceProfile> {
  const res = await sidecarFetch("/api/voice/voices", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await ensureOk(res, "create voice");
  return res.json();
}

export async function updateVoiceProfile(
  id: string,
  patch: Partial<VoiceProfileInput>,
): Promise<VoiceProfile> {
  const res = await sidecarFetch(`/api/voice/voices/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "update voice");
  return res.json();
}

export async function deleteVoiceProfile(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/voice/voices/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });
  await ensureOk(res, "delete voice");
}

/** Uploads a cloning clip, already converted to 16 kHz mono WAV. */
export async function uploadVoiceClip(id: string, wav: Blob): Promise<VoiceProfile> {
  const res = await sidecarFetch(`/api/voice/voices/${encodeURIComponent(id)}/clip`, {
    method: "PUT",
    headers: { "Content-Type": "audio/wav" },
    body: wav,
  });
  await ensureOk(res, "upload clip");
  return res.json();
}

export async function deleteVoiceClip(id: string): Promise<VoiceProfile> {
  const res = await sidecarFetch(`/api/voice/voices/${encodeURIComponent(id)}/clip`, {
    method: "DELETE",
  });
  await ensureOk(res, "remove clip");
  return res.json();
}

/** Studio id for the text-to-speech setup in Settings → Voice. */
export const DEFAULT_STUDIO_VOICE = "default";

export interface StudioTake {
  file: string;
  voiceId: string;
  voiceName: string;
  text: string;
  contentType: string;
  savedPath: string | null;
  createdAt: string;
}

export interface StudioResult {
  takes: StudioTake[];
  failures: { voiceId: string; voiceName: string; error: string }[];
  translation: string | null;
}

export async function listTakes(): Promise<StudioTake[]> {
  const res = await sidecarFetch("/api/voice/studio/takes");
  await ensureOk(res, "studio takes");
  return res.json();
}

export async function generateTakes(input: {
  text: string;
  voiceIds: string[];
  language?: string;
}): Promise<StudioResult> {
  const res = await sidecarFetch("/api/voice/studio/generate", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify(input),
  });
  await ensureOk(res, "generate");
  return res.json();
}

export async function fetchTakeAudio(file: string): Promise<Blob> {
  const res = await sidecarFetch(`/api/voice/studio/takes/${encodeURIComponent(file)}`);
  await ensureOk(res, "take audio");
  return res.blob();
}

/** Copies a take to the Downloads folder. */
export async function saveTake(file: string): Promise<StudioTake> {
  const res = await sidecarFetch(`/api/voice/studio/takes/${encodeURIComponent(file)}/save`, {
    method: "POST",
  });
  await ensureOk(res, "save take");
  return res.json();
}

export type SpeechServerState = "stopped" | "starting" | "running" | "external" | "failed";

export interface SpeechServerStatus {
  state: SpeechServerState;
  port: number;
  baseUrl: string;
  log: string[];
  error: string | null;
}

export interface LocalModelStatus {
  id: string;
  kind: "stt" | "tts";
  cloning: boolean;
  note: string;
  state: "absent" | "downloading" | "downloaded" | "failed";
  error: string | null;
}

export async function getSpeechServer(): Promise<SpeechServerStatus> {
  const res = await sidecarFetch("/api/voice/server");
  await ensureOk(res, "speech server");
  return res.json();
}

export async function setSpeechServerPort(port: number): Promise<SpeechServerStatus> {
  const res = await sidecarFetch("/api/voice/server", {
    method: "PATCH",
    headers: JSON_HEADERS,
    body: JSON.stringify({ port }),
  });
  await ensureOk(res, "speech server port");
  return res.json();
}

export async function startSpeechServer(): Promise<SpeechServerStatus> {
  const res = await sidecarFetch("/api/voice/server/start", { method: "POST" });
  await ensureOk(res, "start speech server");
  return res.json();
}

export async function stopSpeechServer(): Promise<SpeechServerStatus> {
  const res = await sidecarFetch("/api/voice/server/stop", { method: "POST" });
  await ensureOk(res, "stop speech server");
  return res.json();
}

export async function listLocalModels(): Promise<LocalModelStatus[]> {
  const res = await sidecarFetch("/api/voice/server/models");
  await ensureOk(res, "local speech models");
  return res.json();
}

export async function downloadLocalModel(model: string): Promise<void> {
  const res = await sidecarFetch("/api/voice/server/models/download", {
    method: "POST",
    headers: JSON_HEADERS,
    body: JSON.stringify({ model }),
  });
  await ensureOk(res, "download model");
}

/** Registers the local server as a speech provider and returns its id. */
export async function registerSpeechServerProvider(): Promise<string> {
  const res = await sidecarFetch("/api/voice/server/provider", { method: "POST" });
  await ensureOk(res, "register speech provider");
  const body = (await res.json()) as { providerId: string };
  return body.providerId;
}
