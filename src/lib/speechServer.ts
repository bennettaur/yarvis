import { ensureOk, sidecarFetch } from "./api";

/** The local speech server the sidecar runs, under `/api/voice/server`. */

const JSON_HEADERS = { "Content-Type": "application/json" };

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
