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
  providers: { anthropic: boolean; gemini: boolean; cerebras: boolean; huggingface: boolean };
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
export async function sidecarFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const info = await sidecarInfo();
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${info.token}`);
  return fetch(`${baseUrl(info)}${path}`, { ...init, headers });
}

/**
 * Pulls a human-readable reason out of a failed sidecar response body. The
 * sidecar returns `{ error }` where `error` is either a string ("not found")
 * or a Zod `flatten()` object ({ formErrors, fieldErrors }); both are collapsed
 * into one line. Returns null when the body is empty or unparseable so the
 * caller can fall back to the bare status.
 */
async function readErrorDetail(res: Response): Promise<{ reason: string | null; detail?: string }> {
  let raw: string;
  try {
    raw = (await res.text()).trim();
  } catch {
    return { reason: null };
  }
  if (!raw) return { reason: null };

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    // Non-JSON body (e.g. a plain-text error) — surface it verbatim.
    return { reason: raw };
  }

  // Routes that can say more than one line put the diagnosis in `detail`; it is
  // what the UI's expander shows and what a bug report should carry.
  const extra = (body as { detail?: unknown })?.detail;
  const detail = typeof extra === "string" && extra ? extra : raw;

  const err = (body as { error?: unknown })?.error;
  if (typeof err === "string") return { reason: err, detail };
  if (err && typeof err === "object") {
    const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
    const parts: string[] = [];
    if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
    for (const [field, msgs] of Object.entries(flat.fieldErrors ?? {})) {
      if (Array.isArray(msgs) && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
    }
    if (parts.length) return { reason: parts.join("; "), detail };
  }
  return { reason: raw, detail };
}

/**
 * A failed sidecar call. Carries the HTTP status and the server's own longer
 * explanation so the UI can show one line and keep the diagnosis behind an
 * expander instead of throwing it away.
 */
export class SidecarError extends Error {
  readonly status: number;
  readonly detail?: string;

  constructor(message: string, status: number, detail?: string) {
    super(message);
    this.name = "SidecarError";
    this.status = status;
    this.detail = detail;
  }
}

/**
 * Throws a detailed Error when a sidecar response is not ok, reading the
 * server's own reason out of the body so failures surface *why* instead of a
 * bare status code. No-op on ok responses. `context` names the operation
 * (e.g. "create custom provider").
 */
export async function ensureOk(res: Response, context: string): Promise<void> {
  if (res.ok) return;
  const { reason, detail } = await readErrorDetail(res);
  throw new SidecarError(
    reason ? `${context} failed (${res.status}): ${reason}` : `${context} failed: ${res.status}`,
    res.status,
    detail,
  );
}

/** Unauthenticated readiness probe. */
export async function getHealth(): Promise<HealthResponse> {
  const info = await sidecarInfo();
  const res = await fetch(`${baseUrl(info)}/health`);
  await ensureOk(res, "health check");
  return res.json();
}

/**
 * Polls `/health` until the sidecar reports `ready`, with a timeout. Use this
 * after `restartSidecar()` so follow-up HTTP calls don't race the respawn.
 *
 * Pass `minUptimeMsBefore` (the uptime captured *before* triggering the
 * restart) so we wait for a process whose uptime is lower than the old one —
 * otherwise we might see the old process briefly answer before it's killed.
 */
export async function waitForSidecarReady({
  timeoutMs = 10_000,
  intervalMs = 200,
  minUptimeMsBefore,
}: {
  timeoutMs?: number;
  intervalMs?: number;
  minUptimeMsBefore?: number;
} = {}): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const health = await getHealth();
      const isFresh = minUptimeMsBefore === undefined || health.uptimeMs < minUptimeMsBefore;
      if (health.ready && isFresh) return;
    } catch {
      // sidecar is mid-restart; fall through and retry
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("sidecar did not become ready in time");
}

export async function getStatus(): Promise<StatusResponse> {
  const res = await sidecarFetch("/api/status");
  await ensureOk(res, "status");
  return res.json();
}

export async function getDbHealth(): Promise<DbHealthResponse> {
  const res = await sidecarFetch("/api/db/health");
  await ensureOk(res, "db health");
  return res.json();
}

/**
 * Reads a Server-Sent-Events stream from an authenticated sidecar route,
 * yielding each `data:` payload. Used by the chat feature (M1).
 */
export async function* streamSSE(path: string, init: RequestInit = {}): AsyncGenerator<string> {
  const res = await sidecarFetch(path, init);
  await ensureOk(res, "stream");
  if (!res.body) throw new Error("stream failed: response has no body");
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
      const line = event.split("\n").find((l) => l.startsWith("data:"));
      if (line) yield line.slice("data:".length).trim();
    }
  }
}
