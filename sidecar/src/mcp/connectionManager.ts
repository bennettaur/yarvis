import { createMCPClient, type ListToolsResult, type MCPClient } from "@ai-sdk/mcp";
import { Experimental_StdioMCPTransport } from "@ai-sdk/mcp/mcp-stdio";
import type { McpServerSecrets } from "../config.ts";
import type { McpServerRow } from "../db/schema.ts";
import { validateOutboundUrl } from "../lib/urlSafety.ts";
import { redactSecrets } from "../llm/errors.ts";
import { isUnauthorized, type McpOAuthProvider } from "./oauth.ts";

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
  /**
   * Call before closing. A transport reports errors asynchronously, and closing
   * one aborts its in-flight inbound stream — which arrives as an `AbortError`
   * we caused ourselves. Past this point nothing it says is news.
   */
  markClosing: () => void;
}

export interface ServerStatus {
  connected: boolean;
  toolCount: number;
}

/**
 * Whether an error is a cancelled operation rather than a failed one.
 *
 * Closing a transport aborts its in-flight inbound stream, and the rejection
 * that produces is reported through `onUncaughtError` — including when the
 * client library closes the transport itself after a failed connect, which it
 * does before we hold a client to mark. Nothing here ever aborts a request for
 * any other reason, so an abort is always the shutdown we asked for and never
 * news on its own; the failure that caused the shutdown is reported separately.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * Set `YARVIS_DEBUG_MCP=1` when a server's replies don't match the protocol and
 * the schema complaint alone doesn't say why — it prints what the server
 * actually sent. Off by default: these bodies carry whatever the server returns.
 */
const DEBUG_MCP = process.env.YARVIS_DEBUG_MCP === "1";

/** Cap on a logged body, so one `tools/list` can't bury the rest of the log. */
const DEBUG_BODY_LIMIT = 4000;

/**
 * Logs a request and its response body under `YARVIS_DEBUG_MCP`. Reads a clone,
 * leaving the original for the caller, and only for POSTs — the transport's
 * inbound SSE stream is a GET that stays open for the life of the connection, so
 * draining a clone of it would never finish.
 */
async function debugLogExchange(method: string, url: string, response: Response): Promise<void> {
  if (method.toUpperCase() !== "POST") {
    console.info(`[mcp:debug] ${method} ${url} -> ${response.status}`);
    return;
  }
  let body: string;
  try {
    body = await response.clone().text();
  } catch (error) {
    body = `<unreadable: ${error instanceof Error ? error.message : String(error)}>`;
  }
  const shown = body.length > DEBUG_BODY_LIMIT ? `${body.slice(0, DEBUG_BODY_LIMIT)}…` : body;
  console.info(`[mcp:debug] ${method} ${url} -> ${response.status} ${redactSecrets(shown)}`);
}

/**
 * Wraps `fetch` so requests the transport makes to hosts *other than* the
 * configured MCP server are checked before they go out.
 *
 * OAuth is what makes this necessary: the authorization server, its registration
 * endpoint, and its token endpoint are all discovered at runtime from documents
 * the MCP server serves, so none of them passed the check done when the server
 * was configured. Without this, a compromised server could name
 * `http://169.254.169.254/` as its authorization server and have the sidecar
 * fetch it.
 *
 * The check is the static half of the guard — scheme, embedded credentials,
 * literal private IPs, loopback and `.local` hostnames — deliberately not the
 * DNS-resolving half. MCP servers worth connecting to are routinely on a VPN,
 * where the hostname resolves into CGNAT or unique-local space; refusing those
 * would refuse the servers this feature exists for, and the MCP server's own URL
 * is already accepted on the same terms.
 *
 * Requests to the server's own origin skip the check entirely: that URL was
 * validated when it was configured, and every tool call goes through this path.
 */
export function offServerFetchGuard(serverUrl: string): typeof globalThis.fetch {
  const serverOrigin = new URL(serverUrl).origin;
  const guarded = async (
    input: Parameters<typeof globalThis.fetch>[0],
    init?: Parameters<typeof globalThis.fetch>[1],
  ): Promise<Response> => {
    const target = input instanceof Request ? input.url : input.toString();
    if (new URL(target).origin !== serverOrigin) {
      validateOutboundUrl(target);
    }
    const response = await fetch(input, init);
    if (DEBUG_MCP) {
      const method = input instanceof Request ? input.method : (init?.method ?? "GET");
      await debugLogExchange(method, target, response);
    }
    return response;
  };
  // `fetch` carries a `preconnect` member the callers here never use; borrow the
  // global's so the wrapper still satisfies the type.
  return Object.assign(guarded, { preconnect: globalThis.fetch.preconnect });
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
    authProvider?: McpOAuthProvider,
  ): Promise<{ toolCount: number; descriptors: ListToolsResult["tools"] }> {
    await this.disconnect(server.id);
    const transport = this.buildTransport(server, secrets, authProvider);
    let closing = false;
    let saidUnauthorized = false;
    const markClosing = () => {
      closing = true;
    };
    const client = await createMCPClient({
      transport,
      onUncaughtError: (error) => {
        if (closing || isAbort(error)) return;
        // A server that wants OAuth answers 401 until the user has authorized,
        // and the transport reports that here as well as throwing it — once per
        // request in flight. It is the normal first step of a flow, not a fault,
        // so it gets one line and no trace.
        if (isUnauthorized(error)) {
          if (saidUnauthorized) return;
          saidUnauthorized = true;
          console.warn(`[mcp] ${server.name} (${server.id}) needs authorization`);
          return;
        }
        console.error(`[mcp] ${server.name} (${server.id}) uncaught error:`, error);
      },
    });
    try {
      // One `tools/list`, not two: `client.tools()` fetches the same list
      // internally and then builds from it, so asking for both sent the request
      // twice and left the server answering a duplicate it never needed to see.
      const list = await client.listTools();
      const tools = client.toolsFromDefinitions(list);
      this.connections.set(server.id, { client, tools, serverName: server.name, markClosing });
      return { toolCount: list.tools.length, descriptors: list.tools };
    } catch (error) {
      markClosing();
      await client.close().catch(() => {});
      throw error;
    }
  }

  private buildTransport(
    server: McpServerRow,
    secrets: McpServerSecrets | undefined,
    authProvider: McpOAuthProvider | undefined,
  ) {
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
    return {
      type: "http" as const,
      url: server.url,
      headers: secrets?.headers,
      authProvider,
      fetch: offServerFetchGuard(server.url),
    };
  }

  async disconnect(serverId: string): Promise<void> {
    const conn = this.connections.get(serverId);
    if (!conn) return;
    this.connections.delete(serverId);
    conn.markClosing();
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
