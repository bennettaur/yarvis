/**
 * Every frontend call to a Tauri command that writes a secret or decides what
 * command an agent session launches. Keeping them in this one file is what
 * lets the rest of the frontend count as low risk when verifying a pull
 * request: `scripts/verify/nativeBridge.test.ts` fails if any other file calls
 * one of these commands, and `scripts/verify/tier.ts` makes a change here high
 * risk.
 */

import { invoke } from "@tauri-apps/api/core";
import type { CustomProviderSecretSlot, CustomProviderSecretStatus } from "./customProviders";
import type { SecretKey, SecretStatus } from "./keychain";
import type { McpSecretSlot, McpSecretStatus } from "./mcp";
import type { BackendSwitch, SecretBackend, Settings } from "./settings";

/* ---------- App secrets ---------- */

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

export function deleteSecret(key: SecretKey): Promise<void> {
  return invoke("delete_secret", { key });
}

export function listSecretStatus(): Promise<SecretStatus[]> {
  return invoke<SecretStatus[]>("list_secret_status");
}

/* ---------- MCP server secrets ---------- */

export function listMcpSecretStatus(): Promise<McpSecretStatus[]> {
  return invoke<McpSecretStatus[]>("list_mcp_secret_status");
}

export function setMcpSecret(serverId: string, slot: McpSecretSlot, value: string): Promise<void> {
  return invoke("set_mcp_secret", { serverId, slot, value });
}

export function deleteMcpSecret(serverId: string, slot: McpSecretSlot): Promise<void> {
  return invoke("delete_mcp_secret", { serverId, slot });
}

export function deleteAllMcpSecrets(serverId: string): Promise<void> {
  return invoke("delete_mcp_all_secrets", { serverId });
}

/* ---------- Custom provider secrets ---------- */

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

/* ---------- Embeddings secrets ---------- */

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

/* ---------- Secret store and agent command ---------- */

/**
 * Points the app at a different secret store, copying the stored secrets into
 * it first. Rejects when the new store can't be reached, leaving the current
 * one selected — so a failure here is safe to show and retry. The old store's
 * copy is left behind untouched.
 *
 * `vault` and `item` are required for `"onepassword"` and ignored otherwise.
 */
export const setSecretBackend = (
  backend: SecretBackend,
  vault: string | null,
  item: string | null,
) => invoke<BackendSwitch>("set_secret_backend", { backend, vault, item });

/** Sets the agent's tab title and launch command, clearing either back to its
 * default with `null` or a blank string. Takes effect on the next agent session
 * started — no restart. Rejects a value spanning more than one line. */
export const setAgent = (name: string | null, command: string | null) =>
  invoke<Settings>("set_agent", { name, command });
