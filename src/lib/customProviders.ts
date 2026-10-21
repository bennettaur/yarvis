import { invoke } from "@tauri-apps/api/core";
import { ensureOk, sidecarFetch } from "./api";
import type { ModelInfo } from "./chat";

/**
 * Wire protocol the proxy speaks:
 * - `openai`       → Responses API (default for OpenAI SDK)
 * - `openai-chat`  → legacy `/chat/completions` (for gateways without Responses)
 * - `anthropic`    → Anthropic Messages API
 * - `ollama`       → Ollama's native API, needed for its decision models
 */
export type CustomProviderApiKind = "openai" | "openai-chat" | "anthropic" | "ollama";

/** One model the proxy serves, tagged with what it can do, like a catalogue entry. */
export type CustomProviderModel = Pick<ModelInfo, "id" | "capabilities">;

/**
 * Structural fields for a user-configured proxy. Stored in Postgres. Secret
 * values (apiKey + each custom header value) are managed separately via the
 * Tauri commands below and live in the macOS Keychain.
 */
export interface CustomProvider {
  id: string;
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: CustomProviderModel[];
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: CustomProviderModel[];
  headerNames: string[];
}

export type CustomProviderUpdate = Partial<CustomProviderInput>;

export type CustomProviderSecretSlot = "apiKey" | `header:${string}`;

export interface CustomProviderSecretStatus {
  providerId: string;
  apiKeyPresent: boolean;
  /** Header name → whether a value is stored. */
  headers: Record<string, boolean>;
}

/* ---------- Structure (sidecar HTTP, Postgres-backed) ---------- */

export async function listCustomProviders(): Promise<CustomProvider[]> {
  const res = await sidecarFetch("/api/custom-providers");
  await ensureOk(res, "list custom providers");
  return res.json();
}

export async function createCustomProvider(input: CustomProviderInput): Promise<CustomProvider> {
  const res = await sidecarFetch("/api/custom-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "create custom provider");
  return res.json();
}

export async function updateCustomProvider(
  id: string,
  patch: CustomProviderUpdate,
): Promise<CustomProvider> {
  const res = await sidecarFetch(`/api/custom-providers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "update custom provider");
  return res.json();
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/custom-providers/${id}`, {
    method: "DELETE",
  });
  await ensureOk(res, "delete custom provider");
}

/**
 * A failed test is a result, not a thrown error: the sidecar answers 200 with
 * `ok: false` and the provider's own message, so the UI can show why.
 */
export type ConnectionTestResult =
  | { ok: true; latencyMs: number; models: string[] }
  | { ok: false; latencyMs: number; error: string; detail?: string };

export type ModelTestResult =
  | { ok: true; latencyMs: number; reply: string }
  | { ok: false; latencyMs: number; error: string; detail?: string };

/** Asks the proxy for its model list with the saved URL and credentials. */
export async function testCustomProvider(id: string): Promise<ConnectionTestResult> {
  const res = await sidecarFetch(`/api/custom-providers/${id}/test`, { method: "POST" });
  await ensureOk(res, "test custom provider");
  return res.json();
}

/** Sends one model a short prompt through the same path a chat turn uses. */
export async function testCustomProviderModel(id: string, model: string): Promise<ModelTestResult> {
  const res = await sidecarFetch(`/api/custom-providers/${id}/test-model`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model }),
  });
  await ensureOk(res, "test custom provider model");
  return res.json();
}

/* ---------- Secrets (Tauri commands, Keychain-backed) ---------- */

export function listCustomProviderSecretStatus(): Promise<CustomProviderSecretStatus[]> {
  return invoke<CustomProviderSecretStatus[]>("list_custom_provider_secret_status");
}

export function setCustomProviderSecret(
  providerId: string,
  slot: CustomProviderSecretSlot,
  value: string,
): Promise<void> {
  return invoke("set_custom_provider_secret", { providerId, slot, value });
}

export function deleteCustomProviderSecret(
  providerId: string,
  slot: CustomProviderSecretSlot,
): Promise<void> {
  return invoke("delete_custom_provider_secret", { providerId, slot });
}

export function deleteAllCustomProviderSecrets(providerId: string): Promise<void> {
  return invoke("delete_custom_provider_all_secrets", { providerId });
}
