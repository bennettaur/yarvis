/**
 * Every frontend call that can leak a secret or run a command: Tauri commands
 * that write a secret, switch the secret store, set the agent's launch command
 * or type into a shell, and sidecar writes that decide what an MCP server or
 * scheduled job runs, which tools need approval, or where a provider's key is
 * sent. Keeping them here is what lets the rest of the frontend count as low
 * risk when a pull request is verified: `scripts/verify/nativeBridge.ts`
 * fails CI if any other file makes one of these calls or imports this one
 * without being on its list, and `scripts/verify/tier.ts` makes this file and
 * its importers high risk, since an importer chooses the values.
 */

import { invoke } from "@tauri-apps/api/core";
import { ensureOk, sidecarFetch } from "./api";
import type {
  CustomProvider,
  CustomProviderInput,
  CustomProviderSecretSlot,
  CustomProviderUpdate,
} from "./customProviders";
import type { SecretKey } from "./keychain";
import type {
  McpSecretSlot,
  McpServer,
  McpServerInput,
  McpServerUpdate,
  RegistryTool,
  ToolApproval,
  ToolPolicy,
} from "./mcp";
import type { EmbeddingsSecretSlot } from "./memory";
import { jobsRequest, type ScheduledJob, type ScheduledJobInput } from "./scheduledJobs";
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

/* ---------- Shell input ---------- */

/** Sends user input to the session's shell. */
export const writePty = (id: string, data: string) => invoke("pty_write", { id, data });

/* ---------- What MCP servers run and which tools ask first ---------- */

export async function createMcpServer(input: McpServerInput): Promise<McpServer> {
  const res = await sidecarFetch("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  await ensureOk(res, "create mcp server");
  return res.json();
}

export async function updateMcpServer(id: string, patch: McpServerUpdate): Promise<McpServer> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  await ensureOk(res, "update mcp server");
  return res.json();
}

/**
 * Updates what the user controls about a tool — how it is exposed to the model,
 * whether calling it asks first, or both. Fields left out are unchanged.
 */
export async function setToolSettings(
  id: string,
  settings: { policy?: ToolPolicy; approval?: ToolApproval },
): Promise<RegistryTool> {
  const res = await sidecarFetch(`/api/mcp/tools/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(settings),
  });
  await ensureOk(res, "set tool settings");
  return res.json();
}

/* ---------- Where a custom provider's key is sent ---------- */

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

/* ---------- What scheduled jobs run ---------- */

export const createScheduledJob = async (input: ScheduledJobInput): Promise<ScheduledJob> =>
  (await jobsRequest<{ job: ScheduledJob }>("/api/jobs/agent-jobs", "POST", input)).job;

export const updateScheduledJob = async (
  id: string,
  input: ScheduledJobInput,
): Promise<ScheduledJob> =>
  (await jobsRequest<{ job: ScheduledJob }>(`/api/jobs/agent-jobs/${id}`, "PUT", input)).job;
