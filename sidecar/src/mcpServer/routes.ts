import { StreamableHTTPTransport } from "@hono/mcp";
import { Hono } from "hono";
import { bearerAuth } from "hono/bearer-auth";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { chooseEmbedder } from "../memory/embedder.ts";
import { type MemoryService, PgVectorMemoryStore } from "../memory/index.ts";
import { askQuestions, getQuestion, waitForReply } from "../questions/service.ts";
import { listLocatedReviewComments, updateReviewComment } from "../workspaces/reviewComments.ts";
import type { QuestionOrigin } from "./questionTools.ts";
import { UUID } from "./results.ts";
import type { ReviewCommentStore } from "./reviewCommentTools.ts";
import { createYarvisMcpServer, WORKSPACE_HEADER, type WorkspaceContext } from "./server.ts";

/**
 * The MCP endpoint, mounted at `/mcp` OUTSIDE the main bearer wall. Like
 * attention-ingest, it authenticates with its own scoped token, so a Claude Code
 * session (or another MCP client) can call its tools without holding the
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
 *
 * The IPv6 literal is deliberately absent: everything Yarvis hands out (a
 * workspace's `.mcp.json`, the command the Settings screen copies) addresses
 * `127.0.0.1`, and a client that typed `localhost` sends that name in the header
 * whichever family it resolved to.
 */
function allowedHosts(port: number): string[] {
  return [`127.0.0.1:${port}`, `localhost:${port}`];
}

/** Names the terminal a question comes from; a workspace's `.mcp.json` sets it from the PTY's environment. */
const SESSION_KEY_HEADER = "x-yarvis-session-key";
const MAX_SESSION_KEY = 256;

/**
 * Which session is asking. These are the caller's claims, held to the same
 * trust as the attention-ingest body: they only decide where a question is
 * shown. A missing or malformed value reads as absent, since a client Yarvis
 * didn't launch sends neither, and an unset variable expands to an empty string.
 */
export function questionOrigin(headers: Headers): QuestionOrigin {
  const sessionKey = headers.get(SESSION_KEY_HEADER)?.trim() ?? "";
  const workspaceId = headers.get(WORKSPACE_HEADER)?.trim() ?? "";
  // `chat:` keys belong to the in-app assistant's questions, which show as
  // "Yarvis"; a coding agent claiming one could post under that name.
  const valid =
    sessionKey && sessionKey.length <= MAX_SESSION_KEY && !sessionKey.startsWith("chat:");
  return {
    sessionKey: valid ? sessionKey : null,
    workspaceId: UUID.safeParse(workspaceId).success ? workspaceId : null,
  };
}

/**
 * Passes `body` through, calling `onEnd` once it finishes or the reader
 * cancels it. A client that hangs up cancels the stream, which a
 * TransformStream's `flush` would never see.
 */
function onStreamEnd(
  body: ReadableStream<Uint8Array>,
  onEnd: () => void,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        onEnd();
      } else {
        controller.enqueue(value);
      }
    },
    cancel(reason) {
      onEnd();
      return reader.cancel(reason);
    },
  });
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

  const reviewComments = (): ReviewCommentStore => {
    const db = getDb(config.databaseUrl as string).db;
    return {
      list: (workspaceId) => listLocatedReviewComments(db, workspaceId),
      setResolved: (workspaceId, commentId, resolved) =>
        updateReviewComment(db, workspaceId, commentId, { resolved }),
    };
  };

  router.post("/", async (c) => {
    // A malformed id is ignored rather than refused, so the memory tools still
    // work from a session whose header got mangled.
    const workspaceId = c.req.header(WORKSPACE_HEADER);
    const workspace: WorkspaceContext | undefined =
      workspaceId && UUID.safeParse(workspaceId).success
        ? { id: workspaceId, reviewComments }
        : undefined;
    const db = () => getDb(config.databaseUrl as string).db;
    // Fires once the reply stream ends, the client cancels it, or the request
    // aborts. A client that disconnects stops its wait rather than holding a
    // waiter until the timeout, and the per-request server closes with it.
    const done = new AbortController();
    c.req.raw.signal.addEventListener("abort", () => done.abort(), { once: true });
    const server = createYarvisMcpServer(memory, workspace, {
      origin: questionOrigin(c.req.raw.headers),
      ask: (input) => askQuestions(db(), input),
      getQuestion: (id) => getQuestion(db(), id),
      waitForReply: (id, timeoutMs) => waitForReply(db(), id, timeoutMs, done.signal),
    });
    const transport = new StreamableHTTPTransport({
      // Streamed rather than one JSON body, so the reply's headers go out at
      // once. Claude Code gives up on an HTTP tool call whose first byte takes
      // over a minute, and `ask_user` waits far longer than that.
      enableJsonResponse: false,
      enableDnsRebindingProtection: true,
      allowedHosts: allowedHosts(config.port),
    });
    // Closing the server also releases the transport's stream mapping.
    done.signal.addEventListener("abort", () => void server.close(), { once: true });
    try {
      await server.connect(transport);
      const res = await transport.handleRequest(c);
      // The transport answers every case itself, even a 202 for notifications,
      // which carries a body; this branch only satisfies its optional return type.
      if (!res?.body) {
        done.abort();
        return res ?? c.body(null, 202);
      }
      // The stream outlives this handler, so its end is what finishes the request.
      return new Response(
        onStreamEnd(res.body, () => done.abort()),
        {
          status: res.status,
          headers: res.headers,
        },
      );
    } catch (e) {
      done.abort();
      throw e;
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
