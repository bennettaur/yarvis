import { invoke } from "@tauri-apps/api/core";

/** Connection details for the sidecar, provided by the Rust core. */
export interface SidecarInfo {
  port: number;
  token: string;
}

export interface HealthResponse {
  status: string;
  service: string;
  uptimeMs: number;
  /** False while startup migrations run or if they failed. */
  ready?: boolean;
  phase?: "migrating" | "ready" | "error";
  error?: string;
}

export interface StatusResponse {
  service: string;
  databaseConfigured: boolean;
  providers: { anthropic: boolean; gemini: boolean };
}

export interface DbHealthResponse {
  configured: boolean;
  reachable: boolean;
}

let cachedInfo: Promise<SidecarInfo> | null = null;

/** Fetches and caches the sidecar port/token from the Rust core. */
export function sidecarInfo(): Promise<SidecarInfo> {
  if (!cachedInfo) {
    // Don't cache a rejection: clear it so the next call (e.g. the boot-time
    // poll) retries instead of being stuck on a one-time failure.
    cachedInfo = invoke<SidecarInfo>("get_sidecar_info").catch((e) => {
      cachedInfo = null;
      throw e;
    });
  }
  return cachedInfo;
}

function baseUrl(info: SidecarInfo): string {
  return `http://127.0.0.1:${info.port}`;
}

/** Authenticated fetch against the sidecar. Adds the bearer token automatically. */
export async function sidecarFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const info = await sidecarInfo();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${info.token}`);
  return fetch(`${baseUrl(info)}${path}`, { ...init, headers });
}

/** Unauthenticated readiness probe. */
export async function getHealth(): Promise<HealthResponse> {
  const info = await sidecarInfo();
  const res = await fetch(`${baseUrl(info)}/health`);
  if (!res.ok) throw new Error(`health check failed: ${res.status}`);
  return res.json();
}

export async function getStatus(): Promise<StatusResponse> {
  const res = await sidecarFetch("/api/status");
  if (!res.ok) throw new Error(`status failed: ${res.status}`);
  return res.json();
}

export async function getDbHealth(): Promise<DbHealthResponse> {
  const res = await sidecarFetch("/api/db/health");
  if (!res.ok) throw new Error(`db health failed: ${res.status}`);
  return res.json();
}

/**
 * Reads a Server-Sent-Events stream from an authenticated sidecar route,
 * yielding each `data:` payload. Used by the chat feature (M1).
 */
export async function* streamSSE(
  path: string,
  init: RequestInit = {},
): AsyncGenerator<string> {
  const res = await sidecarFetch(path, init);
  if (!res.ok || !res.body) {
    throw new Error(`stream failed: ${res.status}`);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const events = buffer.split("\n\n");
    buffer = events.pop() ?? "";
    for (const event of events) {
      const line = event
        .split("\n")
        .find((l) => l.startsWith("data:"));
      if (line) yield line.slice("data:".length).trim();
    }
  }
}
