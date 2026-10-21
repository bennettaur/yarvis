import { generateText } from "ai";
import type { Config } from "../config.ts";
import { guardedFetch } from "../lib/guardedFetch.ts";
import { clientError, describeError, errorDetail } from "../llm/errors.ts";
import { CUSTOM_PROVIDER_PREFIX, ollamaUrl, resolveModel } from "../llm/providers.ts";
import type { CustomProviderRow } from "./service.ts";

/**
 * Checks a custom provider from Settings before a chat turn depends on it.
 *
 * Two questions, asked separately because they fail for different reasons: can
 * Yarvis reach the proxy with the saved credentials at all, and does each
 * model answer through the same code path a chat turn uses. The second is the
 * one that catches a protocol mismatch, such as a gateway reply the SDK can't
 * parse, which a bare reachability check would pass.
 */

export type ConnectionTestResult =
  | { ok: true; latencyMs: number; models: string[] }
  | { ok: false; latencyMs: number; error: string; detail?: string };

export type ModelTestResult =
  | { ok: true; latencyMs: number; reply: string }
  | { ok: false; latencyMs: number; error: string; detail?: string };

const LIST_TIMEOUT_MS = 15_000;
/** Long enough for a cold model behind a proxy to load and answer one line. */
const MODEL_TIMEOUT_MS = 60_000;
const MODEL_TEST_PROMPT = "Reply with the single word OK.";
/** Room for a reasoning model to think briefly and still answer. */
const MODEL_TEST_MAX_OUTPUT_TOKENS = 256;
const MAX_REPLY_CHARS = 200;

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

/** The model list endpoint and auth headers for the API the proxy speaks. */
function modelListRequest(
  config: Config,
  row: CustomProviderRow,
): { url: string; headers: Record<string, string> } {
  const secrets = config.customProviderSecrets[row.id] ?? { headers: {} };
  const headers: Record<string, string> = { ...secrets.headers };
  const base = row.baseUrl.replace(/\/+$/, "");
  switch (row.apiKind) {
    case "anthropic":
      if (secrets.apiKey) headers["x-api-key"] = secrets.apiKey;
      headers["anthropic-version"] = "2023-06-01";
      return { url: `${base}/models`, headers };
    case "ollama":
      if (secrets.apiKey) headers.Authorization = `Bearer ${secrets.apiKey}`;
      return { url: ollamaUrl(row.baseUrl, "/api/tags"), headers };
    default:
      if (secrets.apiKey) headers.Authorization = `Bearer ${secrets.apiKey}`;
      return { url: `${base}/models`, headers };
  }
}

/** Model ids from an OpenAI- or Anthropic-shaped `{ data: [{ id }] }` or Ollama's `{ models: [{ name }] }`. */
function modelIdsFrom(body: unknown): string[] {
  const record = (body ?? {}) as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : [];
  return entries
    .map(
      (entry) =>
        (entry as { id?: unknown; name?: unknown }).id ?? (entry as { name?: unknown }).name,
    )
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Asks the proxy which models it serves, which proves the URL and credentials work. */
export async function testProviderConnection(
  config: Config,
  row: CustomProviderRow,
  fetchImpl: typeof fetch = fetch,
): Promise<ConnectionTestResult> {
  const started = performance.now();
  const { url, headers } = modelListRequest(config, row);
  try {
    const res = await guardedFetch(
      url,
      { method: "GET", headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
      { fetchImpl, timeoutMs: LIST_TIMEOUT_MS, allowLoopback: true },
    );
    if (!res.ok) {
      // Shaped like an SDK error so the usual helpers redact it and keep the body.
      const failure = {
        message: `The provider refused the model list request`,
        status: res.status,
        url,
        responseBody: await res.text(),
      };
      return {
        ok: false,
        latencyMs: elapsedSince(started),
        error: clientError(failure),
        detail: errorDetail(failure),
      };
    }
    return { ok: true, latencyMs: elapsedSince(started), models: modelIdsFrom(await res.json()) };
  } catch (e) {
    console.warn(`[custom-providers] connection test for ${row.name} failed:`, describeError(e));
    return {
      ok: false,
      latencyMs: elapsedSince(started),
      error: clientError(e),
      detail: errorDetail(e),
    };
  }
}

/** Sends one short prompt to `modelId` the way a chat turn would. */
export async function testProviderModel(
  config: Config,
  row: CustomProviderRow,
  modelId: string,
): Promise<ModelTestResult> {
  const started = performance.now();
  try {
    const model = await resolveModel(config, `${CUSTOM_PROVIDER_PREFIX}${row.id}`, modelId);
    const { text } = await generateText({
      model,
      prompt: MODEL_TEST_PROMPT,
      maxOutputTokens: MODEL_TEST_MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    return {
      ok: true,
      latencyMs: elapsedSince(started),
      reply: text.trim().slice(0, MAX_REPLY_CHARS),
    };
  } catch (e) {
    console.warn(
      `[custom-providers] model test for ${row.name}/${modelId} failed:`,
      describeError(e),
    );
    return {
      ok: false,
      latencyMs: elapsedSince(started),
      error: clientError(e),
      detail: errorDetail(e),
    };
  }
}
