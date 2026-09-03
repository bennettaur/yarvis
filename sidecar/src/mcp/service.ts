import { auth } from "@ai-sdk/mcp";
import { and, eq } from "drizzle-orm";
import { syncToolSet, type ToolDescriptor } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { agentTools, type McpServerRow as PgMcpServerRow } from "../db/schema.ts";
import { clientError, describeError, redactSecrets } from "../llm/errors.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { readSection, withSection } from "../settings/store.ts";
import { getMcpManager, offServerFetchGuard } from "./connectionManager.ts";
import {
  consumeOAuthState,
  discoverProtectedResourceScopes,
  forgetOAuthProvider,
  getOAuthProvider,
  isUnauthorized,
} from "./oauth.ts";

/**
 * MCP server CRUD (structure only — credentials live in the macOS Keychain and
 * reach the sidecar via `YARVIS_MCP_SECRETS`) plus the connect-and-sync
 * orchestration that populates the tool registry from a live server.
 *
 * The server rows themselves live in `~/.yarvis/settings.json` under the
 * `mcpServers` key, keyed by id — the tool registry (`agent_tools`) stays in
 * Postgres, since it carries vector embeddings `settings.json` has no way to
 * hold.
 */

const SETTINGS_KEY = "mcpServers";

export type McpTransport = "http" | "stdio";

export interface McpServerRow {
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

type McpServerTable = Record<string, McpServerRow>;

/**
 * `oauth.ts` and `connectionManager.ts` still type their server parameter
 * against the Postgres-era row, whose `createdAt`/`updatedAt` are `Date`s —
 * neither reads those fields, only `id`, `name`, `transport`, `url`,
 * `command`, `args`, `oauth`, and `oauthScope`, all identical on both shapes.
 * This adapts the settings-file row (ISO strings) at the boundary rather than
 * changing what those modules accept.
 */
function toPgShape(server: McpServerRow): PgMcpServerRow {
  return {
    ...server,
    createdAt: new Date(server.createdAt),
    updatedAt: new Date(server.updatedAt),
  };
}

export function oauthProviderFor(config: Config, server: McpServerRow) {
  return getOAuthProvider(config, toPgShape(server));
}

export async function listMcpServers(): Promise<McpServerRow[]> {
  const table = (await readSection<McpServerTable>(SETTINGS_KEY)) ?? {};
  return Object.values(table).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getMcpServer(id: string): Promise<McpServerRow | null> {
  const table = (await readSection<McpServerTable>(SETTINGS_KEY)) ?? {};
  return table[id] ?? null;
}

export async function createMcpServer(input: McpServerInput): Promise<McpServerRow> {
  const now = new Date().toISOString();
  const row: McpServerRow = {
    id: crypto.randomUUID(),
    name: input.name,
    transport: input.transport,
    url: input.url ?? null,
    command: input.command ?? null,
    args: input.args ?? [],
    headerNames: input.headerNames ?? [],
    oauth: input.oauth ?? false,
    oauthScope: input.oauthScope ?? null,
    enabled: input.enabled ?? true,
    createdAt: now,
    updatedAt: now,
  };
  return withSection<McpServerTable, McpServerRow>(SETTINGS_KEY, (current) => ({
    next: { ...current, [row.id]: row },
    result: row,
  }));
}

export async function updateMcpServer(
  id: string,
  patch: McpServerUpdate,
): Promise<McpServerRow | null> {
  return withSection<McpServerTable, McpServerRow | null>(SETTINGS_KEY, (current) => {
    const existing = current?.[id];
    if (!existing) return { next: current ?? {}, result: null };
    const updated: McpServerRow = { ...existing, ...patch, updatedAt: new Date().toISOString() };
    return { next: { ...current, [id]: updated }, result: updated };
  });
}

export async function deleteMcpServer(db: Db, id: string): Promise<boolean> {
  // Drop the live connection and OAuth state first, exactly as today. The
  // Keychain entry, OAuth included, is cleared by the frontend's
  // `delete_mcp_all_secrets` call.
  await getMcpManager().disconnect(id);
  forgetOAuthProvider(id);
  const existed = await withSection<McpServerTable, boolean>(SETTINGS_KEY, (current) => {
    if (!current?.[id]) return { next: current ?? {}, result: false };
    const { [id]: _removed, ...rest } = current;
    return { next: rest, result: true };
  });
  if (existed) {
    // The Postgres FK that used to cascade-delete these is gone (serverId is now
    // a plain uuid, not a foreign key) — delete them explicitly instead.
    await db
      .delete(agentTools)
      .where(and(eq(agentTools.source, "mcp"), eq(agentTools.serverId, id)));
  }
  return existed;
}

export interface RefreshResult {
  connected: boolean;
  toolCount: number;
  error?: string;
  /**
   * Set when the server answered 401 and OAuth has not been completed. The
   * accompanying `authorizationUrl` is where the user has to consent; it is
   * absent only if discovery itself failed before an authorization URL could be
   * built.
   */
  needsAuthorization?: boolean;
  authorizationUrl?: string;
}

/**
 * Connects (or reconnects) to a server, lists its tools, and reconciles them
 * into the registry — embedding new/changed tools, defaulting them to "search"
 * policy, and removing tools the server no longer offers. A disabled server is
 * disconnected and its tools left in place (so policy survives a toggle).
 * Returns null when the server id is unknown.
 *
 * For an OAuth server with no usable token this is also how a flow starts: the
 * connection attempt gets a 401, the client library runs discovery and
 * registration, and the authorization URL it produces comes back in the result
 * for the frontend to open.
 */
export async function refreshServer(
  config: Config,
  db: Db,
  serverId: string,
): Promise<RefreshResult | null> {
  const server = await getMcpServer(serverId);
  if (!server) return null;
  const manager = getMcpManager();
  if (!server.enabled) {
    await manager.disconnect(serverId);
    return { connected: false, toolCount: 0 };
  }
  const authProvider = oauthProviderFor(config, server);
  // Learn the server's scopes before the first 401 turns into an authorization,
  // so the token we come back with is one it will actually accept.
  if (server.url && authProvider?.needsScopeDiscovery()) {
    authProvider.setDiscoveredScope(
      await discoverProtectedResourceScopes(server.url, offServerFetchGuard(server.url)),
    );
  }
  try {
    const { descriptors } = await manager.connect(
      toPgShape(server),
      config.mcpSecrets[serverId],
      authProvider,
    );
    const embedder = await chooseEmbedder(config, db);
    const toolDescriptors: ToolDescriptor[] = descriptors.map((d) => ({
      id: `mcp:${serverId}:${d.name}`,
      source: "mcp",
      serverId,
      name: d.name,
      description: d.description ?? "",
      inputSchema: d.inputSchema ?? null,
    }));
    await syncToolSet(db, embedder, toolDescriptors, {
      source: "mcp",
      serverId,
      defaultPolicy: "search",
    });
    return { connected: true, toolCount: toolDescriptors.length };
  } catch (error) {
    if (authProvider && isUnauthorized(error)) {
      const authorizationUrl = authProvider.authorizationUrl;
      return {
        connected: false,
        toolCount: 0,
        needsAuthorization: true,
        ...(authorizationUrl ? { authorizationUrl } : {}),
        error: authorizationUrl ? undefined : connectionError(error),
      };
    }
    // The returned string is trimmed for the UI; the log keeps the status, URL,
    // and response body that say what the server actually sent.
    console.error(`[mcp] connecting to ${server.name} (${serverId}) failed:`, describeError(error));
    return { connected: false, toolCount: 0, error: connectionError(error) };
  }
}

/**
 * The client-facing reason a connect failed.
 *
 * `clientError` alone is too thin here. The MCP client library reports a
 * response the protocol schema rejects as a bare "Failed to parse server
 * response" and puts the useful half — which field of which tool the server got
 * wrong — in the cause. A configured MCP server's protocol complaint is not
 * provider account data, so unlike a generation error it belongs in front of the
 * user who has to go fix that server.
 */
export function connectionError(error: unknown): string {
  const base = clientError(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const detail = cause instanceof Error ? cause.message : undefined;
  if (!detail) return base;
  return `${base}: ${redactSecrets(detail).slice(0, 300)}`;
}

/**
 * Starts (or restarts) an authorization, returning the URL the user must open.
 * Returns null when the server is unknown or is not an OAuth server.
 *
 * A flow already waiting on the user is handed back as-is, because the PKCE
 * verifier the callback will need belongs to that one URL. Otherwise any token
 * held is dropped first: the user pressed Authorize, so a token that is somehow
 * still working is not what they asked for, and without dropping it the
 * connection would just succeed and there would be no URL to return.
 */
export async function beginAuthorization(
  config: Config,
  db: Db,
  serverId: string,
): Promise<{ authorizationUrl: string } | null> {
  const server = await getMcpServer(serverId);
  if (!server) return null;
  const provider = oauthProviderFor(config, server);
  if (!provider) return null;
  // A disabled server is never connected to, so the 401 that starts a flow would
  // never come; say so rather than reporting that it didn't ask for one.
  if (!server.enabled) throw new Error("enable the server before authorizing it");
  if (provider.authorizationUrl) {
    return { authorizationUrl: provider.authorizationUrl };
  }
  await provider.invalidateCredentials("tokens");
  const result = await refreshServer(config, db, serverId);
  const url = result?.authorizationUrl ?? provider.authorizationUrl;
  if (!url) {
    throw new Error(result?.error ?? "the server did not ask for authorization");
  }
  return { authorizationUrl: url };
}

/**
 * Finishes an authorization: exchanges the code the loopback callback carried
 * for tokens, then connects and syncs the server's tools so the agent can use
 * them without the user pressing Connect again.
 *
 * `state` is what ties the callback to a server — it was issued by this process
 * for exactly one flow and is single-use, so an unknown value is either a CSRF
 * attempt or a stale tab, and both are refused the same way.
 */
export async function completeAuthorization(
  config: Config,
  db: Db,
  code: string,
  state: string,
): Promise<{ serverName: string }> {
  const serverId = consumeOAuthState(state);
  if (!serverId) throw new Error("unknown or expired authorization request");
  const server = await getMcpServer(serverId);
  if (!server?.url) throw new Error("the server this authorization belongs to is gone");
  const provider = oauthProviderFor(config, server);
  if (!provider) throw new Error("this server no longer uses OAuth");

  const result = await auth(provider, {
    serverUrl: server.url,
    authorizationCode: code,
    callbackState: state,
    fetchFn: offServerFetchGuard(server.url),
  });
  if (result !== "AUTHORIZED") {
    throw new Error("the authorization server did not issue a token");
  }
  await refreshServer(config, db, serverId);
  return { serverName: server.name };
}

/** Forgets a server's tokens and client registration, and drops its connection. */
export async function revokeAuthorization(config: Config, serverId: string): Promise<boolean> {
  const server = await getMcpServer(serverId);
  if (!server) return false;
  const provider = oauthProviderFor(config, server);
  if (!provider) return false;
  await getMcpManager().disconnect(serverId);
  await provider.clear();
  return true;
}
