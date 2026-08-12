import { createMCPClient, type ListToolsResult, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpServerSecrets } from "../config.ts";
import type { McpServerRow } from "../db/schema.ts";
import { validateOutboundUrl } from "../lib/urlSafety.ts";

/**
 * Maintains live connections to enabled MCP servers and exposes their tools.
 *
 * A long-lived singleton in the sidecar process: connections persist across
 * chat turns so a working set of tools stays "hot". The registry (embeddings +
 * policy) is persisted in Postgres separately; this manager only holds the
 * runtime connections and the executable tools used to actually call a server.
 */

/**
 * The subset of the sidecar's own environment passed through to stdio MCP
 * subprocesses. We deliberately do NOT forward the full `process.env` — that
 * would leak Yarvis's own credentials (Anthropic key, DB URL, …) to arbitrary
 * local servers. Only the variables a typical launcher needs to resolve and run
 * a command are forwarded, plus the user-configured per-server secrets.
 */
const SAFE_STDIO_ENV_KEYS = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "SHELL",
];

/**
 * Executable tools as the MCP client hands them back. Taken from the client's
 * own return type rather than written as `Record<string, Tool>`: a server's
 * schemas are only known at runtime, so these carry an unknown input schema,
 * which `Tool`'s own schema parameter will not accept.
 */
export type McpClientTools = Awaited<ReturnType<MCPClient["tools"]>>;

/** A single executable tool from an MCP server. */
export type McpClientTool = McpClientTools[string];

interface Connection {
  client: MCPClient;
  /** Executable AI SDK tools, keyed by the server's bare tool name. */
  tools: McpClientTools;
  serverName: string;
}

export interface ServerStatus {
  connected: boolean;
  toolCount: number;
}

export class McpConnectionManager {
  private readonly connections = new Map<string, Connection>();

  /**
   * (Re)connects to a server and caches its executable tools. Replaces any
   * existing connection for the same server id. Returns the raw tool
   * descriptors (name/description/inputSchema) for registry sync.
   */
  async connect(
    server: McpServerRow,
    secrets: McpServerSecrets | undefined,
  ): Promise<{ toolCount: number; descriptors: ListToolsResult["tools"] }> {
    await this.disconnect(server.id);
    const transport = this.buildTransport(server, secrets);
    const client = await createMCPClient({
      transport,
      onUncaughtError: (error) =>
        console.error(`[mcp] ${server.name} (${server.id}) uncaught error:`, error),
    });
    try {
      const [tools, list] = await Promise.all([client.tools(), client.listTools()]);
      this.connections.set(server.id, { client, tools, serverName: server.name });
      return { toolCount: list.tools.length, descriptors: list.tools };
    } catch (error) {
      await client.close().catch(() => {});
      throw error;
    }
  }

  private buildTransport(server: McpServerRow, secrets: McpServerSecrets | undefined) {
    if (server.transport === "stdio") {
      if (!server.command) throw new Error("stdio MCP server requires a command");
      const env: Record<string, string> = {};
      for (const key of SAFE_STDIO_ENV_KEYS) {
        const value = process.env[key];
        if (value) env[key] = value;
      }
      Object.assign(env, secrets?.env ?? {});
      return new Experimental_StdioMCPTransport({
        command: server.command,
        args: server.args ?? [],
        env,
      });
    }
    if (!server.url) throw new Error("http MCP server requires a url");
    // SSRF guard, matching the custom-provider outbound URL policy.
    validateOutboundUrl(server.url);
    return { type: "http" as const, url: server.url, headers: secrets?.headers };
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.connections.delete(serverId);
    await conn.client
      .close()
      .catch((error) => console.error(`[mcp] closing ${serverId} failed:`, error));
  }

  /**
   * Live, executable tools across all connected servers, keyed by their registry
   * id (`mcp:<serverId>:<toolName>`) so they line up with the `agent_tools`
   * registry and the chat agent's mounted-tool ids.
   */
  getLiveTools(): Record<string, McpClientTool> {
    const out: Record<string, McpClientTool> = {};
    for (const [serverId, conn] of this.connections) {
      for (const [toolName, t] of Object.entries(conn.tools)) {
        out[`mcp:${serverId}:${toolName}`] = t;
      }
    }
    return out;
  }

  status(serverId: string): ServerStatus {
    const conn = this.connections.get(serverId);
    return { connected: conn !== undefined, toolCount: conn ? Object.keys(conn.tools).length : 0 };
  }

  async close(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}

let singleton: McpConnectionManager | null = null;

/** The process-wide MCP connection manager. */
export function getMcpManager(): McpConnectionManager {
  if (!singleton) singleton = new McpConnectionManager();
  return singleton;
}
