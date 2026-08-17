import { auth } from "@ai-sdk/mcp";
import { asc, eq } from "drizzle-orm";
import { syncToolSet, type ToolDescriptor } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type McpServerRow, mcpServers } from "../db/schema.ts";
import { clientError } from "../llm/errors.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { getMcpManager, offServerFetchGuard } from "./connectionManager.ts";
import {
  consumeOAuthState,
  forgetOAuthProvider,
  getOAuthProvider,
  isUnauthorized,
} from "./oauth.ts";

/**
 * MCP server CRUD (structure only — credentials live in the macOS Keychain and
 * reach the sidecar via `YARVIS_MCP_SECRETS`) plus the connect-and-sync
 * orchestration that populates the tool registry from a live server.
 */

export type McpTransport = "http" | "stdio";

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

export async function listMcpServers(db: Db): Promise<McpServerRow[]> {
  return db.select().from(mcpServers).orderBy(asc(mcpServers.name));
}

export async function getMcpServer(db: Db, id: string): Promise<McpServerRow | null> {
  const [row] = await db.select().from(mcpServers).where(eq(mcpServers.id, id));
  return row ?? null;
}

export async function createMcpServer(db: Db, input: McpServerInput): Promise<McpServerRow> {
  const [row] = await db
    .insert(mcpServers)
    .values({
      name: input.name,
      transport: input.transport,
      url: input.url ?? null,
      command: input.command ?? null,
      args: input.args ?? [],
      headerNames: input.headerNames ?? [],
      oauth: input.oauth ?? false,
      oauthScope: input.oauthScope ?? null,
      enabled: input.enabled ?? true,
    })
    .returning();
  return row!;
}

export async function updateMcpServer(
  db: Db,
  id: string,
  patch: McpServerUpdate,
): Promise<McpServerRow | null> {
  const [row] = await db
    .update(mcpServers)
    .set({ ...patch, updatedAt: new Date() })
    .where(eq(mcpServers.id, id))
    .returning();
  return row ?? null;
}

export async function deleteMcpServer(db: Db, id: string): Promise<boolean> {
  // Drop the live connection too; the server's `agent_tools` rows cascade away
  // via the foreign key. The Keychain entry, OAuth included, is cleared by the
  // frontend's `delete_mcp_all_secrets` call.
  await getMcpManager().disconnect(id);
  forgetOAuthProvider(id);
  const rows = await db
    .delete(mcpServers)
    .where(eq(mcpServers.id, id))
    .returning({ id: mcpServers.id });
  return rows.length > 0;
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
  const server = await getMcpServer(db, serverId);
  if (!server) return null;
  const manager = getMcpManager();
  if (!server.enabled) {
    await manager.disconnect(serverId);
    return { connected: false, toolCount: 0 };
  }
  const authProvider = getOAuthProvider(config, server);
  try {
    const { descriptors } = await manager.connect(
      server,
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
        error: authorizationUrl ? undefined : clientError(error),
      };
    }
    return { connected: false, toolCount: 0, error: clientError(error) };
  }
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
  const server = await getMcpServer(db, serverId);
  if (!server) return null;
  const provider = getOAuthProvider(config, server);
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
  const server = await getMcpServer(db, serverId);
  if (!server?.url) throw new Error("the server this authorization belongs to is gone");
  const provider = getOAuthProvider(config, server);
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
export async function revokeAuthorization(
  config: Config,
  db: Db,
  serverId: string,
): Promise<boolean> {
  const server = await getMcpServer(db, serverId);
  if (!server) return false;
  const provider = getOAuthProvider(config, server);
  if (!provider) return false;
  await getMcpManager().disconnect(serverId);
  await provider.clear();
  return true;
}
