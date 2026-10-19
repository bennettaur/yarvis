/**
 * Every frontend call to a Tauri command that writes a secret, switches the
 * secret store or sets the agent's launch command. Shell access is the other
 * privileged kind and lives in `pty.ts`. Keeping them here is what lets the
 * rest of the frontend count as low risk when a pull request is verified:
 * `scripts/verify/nativeBridge.test.ts` fails if any other file calls one of
 * these commands, and `scripts/verify/tier.ts` makes a change here high risk.
 */

import { invoke } from "@tauri-apps/api/core";
import type { CustomProviderSecretSlot } from "./customProviders";
import type { SecretKey } from "./keychain";
import type { McpSecretSlot } from "./mcp";
import type { EmbeddingsSecretSlot } from "./memory";
import type { BackendSwitch, SecretBackend, Settings } from "./settings";

/* ---------- App secrets ---------- */

export function setSecret(key: SecretKey, value: string): Promise<void> {
  return invoke("set_secret", { key, value });
}

export function deleteSecret(key: SecretKey): Promise<void> {
  return invoke("delete_secret", { key });
}

/* ---------- MCP server secrets ---------- */

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
export function setSecretBackend(
  backend: SecretBackend,
  vault: string | null,
  item: string | null,
): Promise<BackendSwitch> {
  return invoke<BackendSwitch>("set_secret_backend", { backend, vault, item });
}

/**
 * Sets the agent's tab title and launch command, clearing either back to its
 * default with `null` or a blank string. Takes effect on the next agent session
 * started — no restart. Rejects a value spanning more than one line.
 */
export function setAgent(name: string | null, command: string | null): Promise<Settings> {
  return invoke<Settings>("set_agent", { name, command });
}
