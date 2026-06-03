import { invoke } from "@tauri-apps/api/core";
import { sidecarFetch } from "./api";

/**
 * Wire protocol the proxy speaks:
 * - `openai`       → Responses API (default for OpenAI SDK)
 * - `openai-chat`  → legacy `/chat/completions` (for gateways without Responses)
 * - `anthropic`    → Anthropic Messages API
 */
export type CustomProviderApiKind = "openai" | "openai-chat" | "anthropic";

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
  models: string[];
  headerNames: string[];
  createdAt: string;
  updatedAt: string;
}

export interface CustomProviderInput {
  name: string;
  baseUrl: string;
  apiKind: CustomProviderApiKind;
  models: string[];
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
  if (!res.ok) throw new Error(`list custom providers failed: ${res.status}`);
  return res.json();
}

export async function createCustomProvider(input: CustomProviderInput): Promise<CustomProvider> {
  const res = await sidecarFetch("/api/custom-providers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create custom provider failed: ${res.status}`);
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
  if (!res.ok) throw new Error(`update custom provider failed: ${res.status}`);
  return res.json();
}

export async function deleteCustomProvider(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/custom-providers/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    throw new Error(`delete custom provider failed: ${res.status}`);
  }
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
