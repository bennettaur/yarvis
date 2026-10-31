import { ensureOk, sidecarFetch } from "./api";

/** The Voice Studio, served by the sidecar under `/api/voice/studio`. */

const JSON_HEADERS = { "Content-Type": "application/json" };

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
