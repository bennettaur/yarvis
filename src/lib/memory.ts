import { invoke } from "@tauri-apps/api/core";
import { sidecarFetch } from "./api";
import type { ProviderId } from "./chat";

export interface MemoryRecord {
  id: string;
  content: string;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  score?: number;
}

export interface RecapTask {
  id: string;
  title: string;
  scope: string;
  notes: string | null;
}

export interface RecapResult {
  label: string;
  recap: string;
  tasks: RecapTask[];
  notes: MemoryRecord[];
}

export interface IngestResult {
  source: string;
  chunks: number;
}

async function get<T>(path: string): Promise<T> {
  const res = await sidecarFetch(path);
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await sidecarFetch(path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${path} -> ${res.status}`);
  return res.json();
}

export const memList = (type?: string) =>
  get<MemoryRecord[]>(`/api/memory${type ? `?type=${encodeURIComponent(type)}` : ""}`);

export const memSearch = (q: string) =>
  get<MemoryRecord[]>(`/api/memory/search?q=${encodeURIComponent(q)}`);

export const memAddNote = (content: string) =>
  send<MemoryRecord>("/api/memory/notes", "POST", { content });

export const memDelete = (id: string) => send<{ deleted: boolean }>(`/api/memory/${id}`, "DELETE");

export const memIngest = (input: { url?: string; text?: string; title?: string }) =>
  send<IngestResult>("/api/memory/ingest", "POST", input);

export const memRecap = (range: "day" | "week", provider?: ProviderId, model?: string) =>
  send<RecapResult>("/api/memory/recap", "POST", { range, provider, model });

/* ---------- Embeddings provider ---------- */

/** Records which model produced a stored vector. */
export interface EmbedderIdentity {
  kind: string;
  model: string;
  dim: number;
}

export interface StoredEmbedderGroup {
  embedder: EmbedderIdentity | null;
  count: number;
}

/** Whether stored memories were all produced by the active embedder. */
export interface EmbedderHealth {
  active: EmbedderIdentity;
  stored: StoredEmbedderGroup[];
  mismatchedCount: number;
  ok: boolean;
}

/** Structural config for the active embeddings provider (no secrets). */
export interface EmbeddingsConfig {
  id: string;
  baseUrl: string;
  model: string;
  apiKind: string;
  dimensions: number;
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface EmbeddingsConfigInput {
  baseUrl: string;
  model: string;
  apiKind: "openai";
  dimensions: number;
  headerNames: string[];
}

export interface EmbeddingsConfigResult {
  config: EmbeddingsConfig | null;
  health: EmbedderHealth;
}

export const memEmbeddingsConfig = () =>
  get<EmbeddingsConfigResult>("/api/memory/embeddings/config");

export const memSetEmbeddingsConfig = (input: EmbeddingsConfigInput) =>
  send<EmbeddingsConfig>("/api/memory/embeddings/config", "PUT", input);

export const memDeleteEmbeddingsConfig = () =>
  send<{ deleted: boolean }>("/api/memory/embeddings/config", "DELETE");

export const memReembed = () => send<{ reembedded: number }>("/api/memory/reembed", "POST");

/* ---------- Embeddings secrets (Tauri commands, Keychain-backed) ---------- */

export type EmbeddingsSecretSlot = "apiKey" | `header:${string}`;

export interface EmbeddingsSecretStatus {
  apiKeyPresent: boolean;
  /** Header name → whether a value is stored. */
  headers: Record<string, boolean>;
}

export function getEmbeddingsSecretStatus(): Promise<EmbeddingsSecretStatus> {
  return invoke<EmbeddingsSecretStatus>("get_embeddings_secret_status");
}

export function setEmbeddingsSecret(slot: EmbeddingsSecretSlot, value: string): Promise<void> {
  return invoke("set_embeddings_secret", { slot, value });
}

export function deleteEmbeddingsSecret(slot: EmbeddingsSecretSlot): Promise<void> {
  return invoke("delete_embeddings_secret", { slot });
}
