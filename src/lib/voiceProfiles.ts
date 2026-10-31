import { ensureOk, sidecarFetch } from "./api";

/** Saved voices, served by the sidecar under `/api/voice/voices`. */

const JSON_HEADERS = { "Content-Type": "application/json" };

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
