import { asc, eq } from "drizzle-orm";
import { syncToolSet, type ToolDescriptor } from "../agentTools/store.ts";
import type { Config } from "../config.ts";
import type { Db } from "../db/client.ts";
import { type McpServerRow, mcpServers } from "../db/schema.ts";
import { clientError } from "../llm/errors.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { getMcpManager } from "./connectionManager.ts";

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
  // via the foreign key.
  await getMcpManager().disconnect(id);
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
}

/**
 * Connects (or reconnects) to a server, lists its tools, and reconciles them
 * into the registry — embedding new/changed tools, defaulting them to "search"
 * policy, and removing tools the server no longer offers. A disabled server is
 * disconnected and its tools left in place (so policy survives a toggle).
 * Returns null when the server id is unknown.
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
  try {
    const { descriptors } = await manager.connect(server, config.mcpSecrets[serverId]);
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
    return { connected: false, toolCount: 0, error: clientError(error) };
  }
}
