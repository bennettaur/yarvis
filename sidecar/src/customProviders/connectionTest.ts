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

type Failure = Extract<ConnectionTestResult, { ok: false }>;

const LIST_TIMEOUT_MS = 15_000;
/** Long enough for a cold model behind a proxy to load and answer one line. */
const MODEL_TIMEOUT_MS = 60_000;
const MODEL_TEST_PROMPT = "Reply with the single word OK.";
/**
 * Room for a model that thinks before answering. Anthropic's smallest thinking
 * budget is 1024 tokens, and the answer has to fit beside it.
 */
const MODEL_TEST_MAX_OUTPUT_TOKENS = 2048;
/** Low, so a model tagged `reasoning` is tested with an effort without a long wait. */
const MODEL_TEST_EFFORT = "low";
const MAX_REPLY_CHARS = 200;
/** Shorter values are too likely to match ordinary text to be worth scrubbing. */
const MIN_SCRUBBED_SECRET_CHARS = 6;

function elapsedSince(started: number): number {
  return Math.round(performance.now() - started);
}

/**
 * Replaces this provider's saved key and header values in `text`.
 *
 * `redactSecrets` only knows common credential shapes and header names. A
 * gateway that echoes back the request it refused can repeat a custom header
 * with any name, and this text is what the UI offers to copy into a bug report.
 */
function scrubSavedSecrets(config: Config, row: CustomProviderRow, text: string): string {
  const secrets = config.customProviderSecrets[row.id];
  const values = [secrets?.apiKey, ...Object.values(secrets?.headers ?? {})].filter(
    (v): v is string => typeof v === "string" && v.length >= MIN_SCRUBBED_SECRET_CHARS,
  );
  return values.reduce((out, value) => out.replaceAll(value, "[redacted]"), text);
}

/** A failed test as the UI shows it, logged once with the same scrubbing. */
function failure(
  config: Config,
  row: CustomProviderRow,
  what: string,
  started: number,
  error: unknown,
): Failure {
  const scrub = (text: string) => scrubSavedSecrets(config, row, text);
  console.warn(`[custom-providers] ${what} for ${row.name} failed:`, scrub(describeError(error)));
  return {
    ok: false,
    latencyMs: elapsedSince(started),
    error: scrub(clientError(error)),
    detail: scrub(errorDetail(error)),
  };
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

/**
 * Model ids from an OpenAI- or Anthropic-shaped `{ data: [{ id }] }` or
 * Ollama's `{ models: [{ name }] }`, or null for a body that is neither.
 */
function modelIdsFrom(body: unknown): string[] | null {
  const record = (body ?? {}) as { data?: unknown; models?: unknown };
  const entries = Array.isArray(record.data)
    ? record.data
    : Array.isArray(record.models)
      ? record.models
      : null;
  if (!entries) return null;
  return entries
    .map((entry) => {
      const { id, name } = (entry ?? {}) as { id?: unknown; name?: unknown };
      return id ?? name;
    })
    .filter((id): id is string => typeof id === "string" && id.length > 0);
}

/** Asks the proxy which models it serves, which proves the URL and credentials work. */
export async function testProviderConnection(
  config: Config,
  row: CustomProviderRow,
): Promise<ConnectionTestResult> {
  const started = performance.now();
  const { url, headers } = modelListRequest(config, row);
  // Shaped like an SDK error, so the usual helpers redact it and keep the body.
  const httpFailure = (message: string, status: number, responseBody: string) =>
    failure(config, row, "connection test", started, { message, status, url, responseBody });
  try {
    const res = await guardedFetch(
      url,
      // This signal also bounds reading the body, which outlives guardedFetch's own deadline.
      { method: "GET", headers, signal: AbortSignal.timeout(LIST_TIMEOUT_MS) },
      {
        fetchImpl: fetch,
        timeoutMs: LIST_TIMEOUT_MS,
        // Local providers, such as an Ollama server, live on loopback.
        allowLoopback: true,
        // The request is nothing but credentials, so it never follows a redirect to another host.
        sameOriginOnly: true,
      },
    );
    const text = await res.text();
    if (res.status >= 300 && res.status < 400) {
      return httpFailure("The provider redirected without saying where", res.status, text);
    }
    if (!res.ok)
      return httpFailure("The provider refused the model list request", res.status, text);

    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return httpFailure("The provider's model list wasn't JSON", res.status, text);
    }
    const models = modelIdsFrom(body);
    if (!models) {
      return httpFailure("The provider's reply wasn't a model list", res.status, text);
    }
    return { ok: true, latencyMs: elapsedSince(started), models };
  } catch (e) {
    return failure(config, row, "connection test", started, e);
  }
}

/**
 * Sends one short prompt to `modelId` the way a chat turn would. A model the
 * catalogue tags `reasoning` is asked for an effort too, since that changes
 * what the request looks like. Retries are off: this is a diagnostic the user
 * is watching, so it should show the first failure, not wait out a backoff.
 */
export async function testProviderModel(
  config: Config,
  row: CustomProviderRow,
  modelId: string,
): Promise<ModelTestResult> {
  const started = performance.now();
  try {
    const model = await resolveModel(config, `${CUSTOM_PROVIDER_PREFIX}${row.id}`, modelId, {
      effort: MODEL_TEST_EFFORT,
    });
    const { text } = await generateText({
      model,
      prompt: MODEL_TEST_PROMPT,
      maxOutputTokens: MODEL_TEST_MAX_OUTPUT_TOKENS,
      maxRetries: 0,
      abortSignal: AbortSignal.timeout(MODEL_TIMEOUT_MS),
    });
    return {
      ok: true,
      latencyMs: elapsedSince(started),
      reply: text.trim().slice(0, MAX_REPLY_CHARS),
    };
  } catch (e) {
    return failure(config, row, `model test of ${modelId}`, started, e);
  }
}
