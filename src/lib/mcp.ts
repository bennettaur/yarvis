import { invoke } from "@tauri-apps/api/core";
import { sidecarFetch } from "./api";

/**
 * Two sides of MCP. Most of this file is the client: the servers Yarvis connects
 * out to, plus the unified tool registry. It mirrors the custom-providers split
 * — structural data goes through the sidecar HTTP API (Postgres-backed), while
 * credential values (HTTP auth headers, stdio env vars) are managed via Tauri
 * commands and live in the macOS Keychain. OAuth is the exception on both
 * counts: the sidecar drives the flow and writes the resulting tokens to the
 * Keychain itself, so the frontend only starts it and opens the browser. The
 * last section is the other side: where outside clients connect to the endpoint
 * Yarvis itself serves.
 */

export type McpTransport = "http" | "stdio";
export type ToolPolicy = "always" | "search" | "disabled";
export type ToolSource = "builtin" | "mcp";

/** Structural fields for a configured MCP server (no secrets). */
export interface McpServer {
  id: string;
  name: string;
  transport: McpTransport;
  url: string | null;
  command: string | null;
  args: string[];
  headerNames: string[];
  oauth: boolean;
  oauthScope: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface McpServerInput {
  name: string;
  transport: McpTransport;
  url?: string | null;
  command?: string | null;
  args?: string[];
  headerNames?: string[];
  oauth?: boolean;
  oauthScope?: string | null;
  enabled?: boolean;
}

export type McpServerUpdate = Partial<McpServerInput>;

/** A row in the unified tool registry (built-in or MCP-sourced). */
export interface RegistryTool {
  id: string;
  source: ToolSource;
  serverId: string | null;
  name: string;
  description: string;
  inputSchema: unknown;
  policy: ToolPolicy;
  contentHash: string;
  createdAt: string;
  updatedAt: string;
}

export interface ToolSearchHit {
  id: string;
  name: string;
  source: ToolSource;
  serverId: string | null;
  description: string;
  score: number;
}

export interface RefreshResult {
  connected: boolean;
  toolCount: number;
  error?: string;
  /** The server answered 401 and needs the user to authorize at the URL below. */
  needsAuthorization?: boolean;
  authorizationUrl?: string;
}

/** How far through the OAuth flow a server is. Null when it doesn't use OAuth. */
export interface McpOAuthStatus {
  registered: boolean;
  authorized: boolean;
  scope: string | null;
}

export interface ServerStatus {
  connected: boolean;
  toolCount: number;
  oauth: McpOAuthStatus | null;
}

export type McpSecretSlot = `header:${string}` | `env:${string}`;

export interface McpSecretStatus {
  serverId: string;
  /** Header name → whether a value is stored. */
  headers: Record<string, boolean>;
  /** Env var name → whether a value is stored. */
  env: Record<string, boolean>;
}

/* ---------- Structure (sidecar HTTP, Postgres-backed) ---------- */

export async function listMcpServers(): Promise<McpServer[]> {
  const res = await sidecarFetch("/api/mcp/servers");
  if (!res.ok) throw new Error(`list mcp servers failed: ${res.status}`);
  return res.json();
}

export async function createMcpServer(input: McpServerInput): Promise<McpServer> {
  const res = await sidecarFetch("/api/mcp/servers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`create mcp server failed: ${res.status}`);
  return res.json();
}

export async function updateMcpServer(id: string, patch: McpServerUpdate): Promise<McpServer> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`update mcp server failed: ${res.status}`);
  return res.json();
}

export async function deleteMcpServer(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) {
    throw new Error(`delete mcp server failed: ${res.status}`);
  }
}

export async function refreshMcpServer(id: string): Promise<RefreshResult> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}/refresh`, { method: "POST" });
  if (!res.ok) throw new Error(`refresh mcp server failed: ${res.status}`);
  return res.json();
}

export async function getMcpServerStatus(id: string): Promise<ServerStatus> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}/status`);
  if (!res.ok) throw new Error(`mcp server status failed: ${res.status}`);
  return res.json();
}

/**
 * Starts the MCP authorization flow and returns the URL the user must open in a
 * browser. Safe to call again for a flow already in progress — the same URL
 * comes back, since the PKCE verifier behind it is only valid for that one.
 */
export async function authorizeMcpServer(id: string): Promise<{ authorizationUrl: string }> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}/authorize`, { method: "POST" });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.error ?? `authorize mcp server failed: ${res.status}`);
  }
  return res.json();
}

/** Forgets a server's OAuth tokens and client registration. */
export async function disconnectMcpOAuth(id: string): Promise<void> {
  const res = await sidecarFetch(`/api/mcp/servers/${id}/oauth/disconnect`, { method: "POST" });
  if (!res.ok) throw new Error(`disconnect mcp oauth failed: ${res.status}`);
}

export async function listAgentTools(): Promise<RegistryTool[]> {
  const res = await sidecarFetch("/api/mcp/tools");
  if (!res.ok) throw new Error(`list agent tools failed: ${res.status}`);
  return res.json();
}

export async function setToolPolicy(id: string, policy: ToolPolicy): Promise<RegistryTool> {
  const res = await sidecarFetch(`/api/mcp/tools/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ policy }),
  });
  if (!res.ok) throw new Error(`set tool policy failed: ${res.status}`);
  return res.json();
}

export async function searchTools(query: string, limit?: number): Promise<ToolSearchHit[]> {
  const res = await sidecarFetch("/api/mcp/tools/search", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, limit }),
  });
  if (!res.ok) throw new Error(`tool search failed: ${res.status}`);
  return res.json();
}

/* ---------- The endpoint Yarvis serves (process config, not stored) ---------- */

/** Where an outside MCP client connects to Yarvis, and with what token. */
export interface McpEndpoint {
  url: string;
  token: string;
}

/**
 * Connection details for the MCP endpoint Yarvis *serves* (the memory tools), as
 * opposed to the servers it connects out to above. Sessions Yarvis launches are
 * wired up automatically; this is for a client it didn't spawn.
 */
export async function getMcpEndpoint(): Promise<McpEndpoint> {
  const res = await sidecarFetch("/api/mcp-endpoint/connection");
  if (!res.ok) throw new Error(`mcp endpoint failed: ${res.status}`);
  return res.json();
}

/* ---------- Secrets (Tauri commands, Keychain-backed) ---------- */

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
