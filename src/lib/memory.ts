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

/**
 * Reads the server's response body for an error message. Routes here return
 * either `{ error: string }` or `{ error: <zod flattened> }`; both are folded
 * to a single line so the UI can surface it verbatim.
 */
async function readErrorBody(res: Response): Promise<string> {
  const text = await res.text().catch(() => "");
  if (!text) return "";
  try {
    const parsed = JSON.parse(text);
    const err = parsed?.error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object") return JSON.stringify(err);
  } catch {
    // not JSON; fall through and return the raw text
  }
  return text.slice(0, 500);
}

/**
 * Flattens a fetch failure into a single string. WebKit (Tauri's webview on
 * macOS) surfaces network errors as `TypeError: Load failed` with no further
 * detail at the top level — the underlying cause, if any, lives on
 * `error.cause`. We walk the chain so the surfaced message says something more
 * actionable than "Load failed", and we also log the full error object to the
 * console so devtools shows the stack and any cause chain.
 */
function describeFetchFailure(method: string, path: string, e: unknown): Error {
  const parts: string[] = [];
  let cur: unknown = e;
  for (let depth = 0; depth < 5 && cur; depth++) {
    if (cur instanceof Error) {
      parts.push(cur.message || cur.name);
      cur = (cur as { cause?: unknown }).cause;
    } else {
      parts.push(String(cur));
      break;
    }
  }
  const detail = parts.join(" ← ") || "unknown error";
  console.error(`[sidecar] ${method} ${path} failed`, e);
  return new Error(`${method} ${path}: ${detail}`);
}

async function get<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await sidecarFetch(path);
  } catch (e) {
    throw describeFetchFailure("GET", path, e);
  }
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(`GET ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
  return res.json();
}

async function send<T>(path: string, method: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await sidecarFetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw describeFetchFailure(method, path, e);
  }
  if (!res.ok) {
    const detail = await readErrorBody(res);
    throw new Error(`${method} ${path} → ${res.status}${detail ? `: ${detail}` : ""}`);
  }
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
