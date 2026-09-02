import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { isModelCapability } from "../llm/catalog.ts";
import { clientError, describeError, errorDetail } from "../llm/errors.ts";
import { availableProviders, reasoningOptions, resolveModel } from "../llm/providers.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import { listMcpServers } from "../mcp/service.ts";
import { runAgentTurn } from "./agent.ts";
import { createSession, getMessages, listSessions } from "./service.ts";

// Re-exported from the shared agent module so the existing context test (which
// imports it from here) keeps passing and callers have one import surface.
export { buildScreenContextMessage } from "./agent.ts";

const chatSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1),
  provider: z.string().min(1),
  model: z.string().min(1),
  context: z.string().max(8000).optional(),
  /**
   * Which in-app surface sent this turn. Only "voice" is nameable: it marks a
   * turn the user spoke instead of typing, which is what puts the destructive
   * tools behind a confirmation. Absent means the chat composer, where the user
   * read what they sent. ("telegram" is not accepted here — the bot writes its
   * own metadata and never comes through this route.)
   */
  source: z.literal("voice").optional(),
  /**
   * Ask the provider to return the model's reasoning for this turn. Off by
   * default: on the providers that support it, thinking costs tokens and time,
   * so it is the user's choice per surface rather than something always on.
   */
  reasoning: z.boolean().optional(),
});

const createSessionSchema = z.object({ title: z.string().nullish() });

const approvalSchema = z.object({ approved: z.boolean() });

/** Chat routes, mounted under /api/chat. */
export function createChatRoutes(config: Config): Hono {
  const router = new Hono();

  /**
   * Defaults to chat-capable models only: everything reaching this route is
   * choosing a model to think with, and a provider's catalogue can also hold
   * speech models that have no completion to give. `?capability=` overrides it
   * for a caller that wants a different half.
   */
  router.get("/providers", async (c) => {
    const requested = c.req.query("capability");
    if (requested !== undefined && !isModelCapability(requested)) {
      return c.json({ error: `unknown capability: ${requested}` }, 400);
    }
    return c.json(await availableProviders(config, requested ?? "chat"));
  });

  // Routes below need a database.
  router.use("*", async (c, next) => {
    if (!config.databaseUrl) {
      return c.json({ error: "database not configured" }, 503);
    }
    return next();
  });

  const db = () => getDb(config.databaseUrl as string).db;

  router.get("/sessions", async (c) => c.json(await listSessions(db())));

  router.post("/sessions", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const parsed = createSessionSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    return c.json(await createSession(db(), parsed.data.title), 201);
  });

  router.get("/sessions/:id/messages", async (c) =>
    c.json(await getMessages(db(), c.req.param("id"))),
  );

  router.post("/", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = chatSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const { sessionId, message, provider, model, context, source, reasoning } = parsed.data;

    const dbh = db();
    let chatModel;
    try {
      chatModel = await resolveModel(config, provider, model);
    } catch (e) {
      console.error("[chat] model resolution failed:", describeError(e));
      return c.json({ error: clientError(e), detail: errorDetail(e) }, 400);
    }
    const servers = await listMcpServers();
    const serverNames = new Map(servers.map((s) => [s.id, s.name]));
    const providerOptions = reasoning ? await reasoningOptions(provider, model) : undefined;

    return streamSSE(c, async (stream) => {
      // Tool-approval requests are emitted from inside a tool's `execute`, out of
      // band with the delta loop. Serialize every write through one chain so the
      // two producers can't interleave and corrupt the SSE framing.
      let writeChain: Promise<void> = Promise.resolve();
      const safeWrite = (data: unknown): Promise<void> => {
        writeChain = writeChain.then(() => stream.writeSSE({ data: JSON.stringify(data) }));
        return writeChain;
      };

      // The agent yields delta/attention/error/done events; map each onto the
      // SSE wire protocol the frontend consumes. `done.text` is ignored here
      // because the deltas already carried the full reply to the client.
      for await (const event of runAgentTurn({
        config,
        db: dbh,
        model: chatModel,
        sessionId,
        message,
        context,
        userMetadata: source ? { source } : undefined,
        serverNames,
        providerOptions,
        // Cancel the upstream call if the client disconnects.
        signal: c.req.raw.signal,
        // This surface holds a live channel to the user, so it can ask for MCP
        // tool approval; the answer comes back on POST /approvals/:toolCallId.
        approval: {
          signal: c.req.raw.signal,
          onRequest: async ({ toolCallId, id, args }) => {
            const [, serverId = "", ...rest] = id.split(":");
            await safeWrite({
              type: "tool_approval_request",
              id: toolCallId,
              name: rest.join(":"),
              server: serverNames.get(serverId) ?? serverId,
              args,
            });
          },
        },
      })) {
        if (event.type === "delta") {
          await safeWrite({ type: "delta", text: event.text });
        } else if (event.type === "reasoning") {
          await safeWrite({ type: "reasoning", text: event.text });
        } else if (event.type === "tool_call") {
          await safeWrite({
            type: "tool_call",
            id: event.id,
            name: event.name,
            server: event.server,
            args: event.args,
          });
        } else if (event.type === "tool_result") {
          await safeWrite({
            type: "tool_result",
            id: event.id,
            status: event.status,
            result: event.result,
            durationMs: event.durationMs,
          });
        } else if (event.type === "attention") {
          await safeWrite({ type: "attention", reason: event.reason });
        } else if (event.type === "error") {
          await safeWrite({ type: "error", message: event.message, detail: event.detail });
        } else if (event.type === "done") {
          await safeWrite({
            type: "done",
            finishReason: event.finishReason,
            steps: event.steps,
          });
        }
      }
    });
  });

  // Human-in-the-loop response to a pending MCP tool call. The chat stream emits
  // a `tool_approval_request` (keyed by the tool call id) and the tool's execute
  // blocks until this resolves it.
  router.post("/approvals/:toolCallId", async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = approvalSchema.safeParse(body);
    if (!parsed.success) return c.json({ error: parsed.error.flatten() }, 400);
    const delivered = resolveApproval(c.req.param("toolCallId"), parsed.data.approved);
    return c.json({ delivered });
  });

  return router;
}
