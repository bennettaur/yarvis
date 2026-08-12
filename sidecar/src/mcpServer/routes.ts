import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { type MemoryService, PgVectorMemoryStore } from "../memory/index.ts";
import { createYarvisMcpServer } from "./server.ts";

/**
 * The MCP endpoint, mounted at `/mcp` OUTSIDE the main bearer wall. Like
 * attention-ingest, it authenticates with its own scoped token, so a Claude Code
 * session (or another MCP client) can call the memory tools without holding the
 * full-access bearer that the webview uses.
 *
 * Each request gets a fresh server + transport (stateless mode): the transport
 * keys in-flight requests by their JSON-RPC id, so a shared instance would let
 * two clients that both start at id 1 collide. Building one per request costs a
 * few objects and removes the question entirely.
 */

/** JSON-RPC error body for the verbs a stateless endpoint doesn't serve. */
const METHOD_NOT_ALLOWED = {
  jsonrpc: "2.0",
  error: { code: -32000, message: "Method not allowed: this MCP endpoint accepts POST only" },
  id: null,
} as const;

/**
 * Hosts a request may claim to have addressed. The endpoint binds to loopback,
 * but a page in a browser can resolve a name it controls to 127.0.0.1 and reach
 * it — so the transport is told which Host values are ours, the same way the app
 * pins CORS to the webview's origins rather than trusting the token alone.
 */
function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

export function createMcpEndpointRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", bearerAuth({ token: config.mcpToken }));

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  // Resolving the embedder reads the embeddings provider config from Postgres,
  // so the store is built per tool call rather than held open here.
  const memory = async (): Promise<MemoryService> => {
    const db = getDb(config.databaseUrl as string).db;
    return new PgVectorMemoryStore(db, await chooseEmbedder(config, db));
  };

  router.post("/", async (c) => {
    const server = createYarvisMcpServer(memory);
    const transport = new StreamableHTTPTransport({
      enableJsonResponse: true,
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(config.port),
    });
    try {
      await server.connect(transport);
      // The transport answers every case itself (including 202 for a batch of
      // notifications); the fallback only satisfies its optional return type.
      return (await transport.handleRequest(c)) ?? c.body(null, 202);
    } finally {
      // Closes the transport too, releasing this request's stream mapping.
      await server.close();
    }
  });

  // No server-initiated stream and no sessions to terminate: the spec's answer
  // for both is 405, which clients treat as "POST-only server".
  router.get("/", (c) => c.json(METHOD_NOT_ALLOWED, 405, { Allow: "POST" }));
  router.delete("/", (c) => c.json(METHOD_NOT_ALLOWED, 405, { Allow: "POST" }));

  return router;
}

/**
 * Connection details for the MCP endpoint, behind the main bearer wall so the
 * Settings screen can show them. Yarvis-launched sessions are configured
 * automatically (see `workspaces/mcpConfig.ts`); this is what an outside client
 * — Claude Code in a terminal Yarvis didn't spawn, another editor — needs to be
 * pointed at the endpoint by hand.
 */
export function createMcpEndpointInfoRoutes(config: Config): Hono {
  const router = new Hono();

  router.get("/connection", (c) =>
    c.json({
      url: `http://127.0.0.1:${config.port}/mcp`,
      token: config.mcpToken,
    }),
  );

  return router;
}
