import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runAgentTurn } from "../chat/agent.ts";
import { getChatBudget } from "../chat/config.ts";
import { createSession, getMessages, listSessions } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { clientError, describeError, redactSecrets } from "../llm/errors.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";
import { resolveApproval } from "../mcp/approvals.ts";
import { listMcpServers } from "../mcp/service.ts";

/**
 * Chat with the agent from the extension's side panel, mounted at
 * `/browser/chat` behind the browser bridge's host pin and scoped token.
 *
 * A turn asks the panel before any tool that needs approval, the same way the
 * in-app chat does: the request goes out on the turn's stream and the answer
 * comes back on `/approvals/:toolCallId`. Because the tab's page-written text
 * rides along on every turn, the destructive built-ins ask here too (see
 * `runAgentTurn`).
 */

/** The panel shows recent sessions to pick from, not the whole history. */
const MAX_SESSIONS = 50;

/**
 * A native message to the extension is capped at 1 MiB, so a long thread is
 * sent from its newest end, up to a count and a size that leave room for the
 * framing. The full thread is in the app.
 */
const MAX_THREAD_MESSAGES = 60;
const MAX_THREAD_BYTES = 800_000;

/**
 * An approval prompt shows the arguments so the user knows what they allow.
 * Each string is cut rather than the whole, so a long body can't push the
 * recipient or address out of view.
 */
const MAX_APPROVAL_STRING_CHARS = 300;

const MAX_SELECTION_CHARS = 2_000;

/**
 * The tab beside the panel when the message was sent. The title, URL and
 * selection are written by the page, so they reach the model fenced as data.
 */
const tabSchema = z.object({
  tabId: z.number().int().nonnegative(),
  url: z.string().max(2_000),
  title: z.string().max(500),
  selection: z.string().max(MAX_SELECTION_CHARS).optional(),
  /** The Chrome profile's name, which the browser tools take as `profile`. */
  profile: z.string().min(1).max(40),
});

export type BrowserTab = z.infer<typeof tabSchema>;

const sendSchema = z.object({
  sessionId: z.string().uuid(),
  message: z.string().min(1).max(20_000),
  tab: tabSchema.optional(),
});

const createSessionSchema = z.object({ title: z.string().max(200).nullish() });

const approvalSchema = z.object({ approved: z.boolean() });

/** The newest messages that fit the panel's count and size limits, oldest first. */
export function newestThatFit<T extends { content: string }>(messages: T[]): T[] {
  const kept: T[] = [];
  let bytes = 0;
  for (let i = messages.length - 1; i >= 0 && kept.length < MAX_THREAD_MESSAGES; i--) {
    const message = messages[i] as T;
    // Chrome's cap is on the UTF-8 JSON, where escapes and non-ASCII text weigh more than a character.
    bytes += Buffer.byteLength(JSON.stringify(message.content));
    if (bytes > MAX_THREAD_BYTES) break;
    kept.push(message);
  }
  return kept.reverse();
}

/** How a tool asking for approval is named to the user: `mcp:<server>:<tool>` or a bare built-in. */
function describeToolId(id: string, serverNames: ReadonlyMap<string, string>) {
  const [kind, serverId = "", ...rest] = id.split(":");
  if (kind !== "mcp" || rest.length === 0) return { name: id };
  return { name: rest.join(":"), server: serverNames.get(serverId) ?? serverId };
}

export function previewArgs(args: unknown): string {
  const text = JSON.stringify(
    args ?? {},
    (_key, value) =>
      typeof value === "string" && value.length > MAX_APPROVAL_STRING_CHARS
        ? `${value.slice(0, MAX_APPROVAL_STRING_CHARS)}… (${value.length - MAX_APPROVAL_STRING_CHARS} more characters)`
        : value,
    2,
  );
  // The arguments leave the sidecar for the extension, so credential shapes are masked.
  return redactSecrets(text ?? "");
}

/**
 * What the agent is told about the tab, attached as this turn's screen context.
 * The fields are JSON so a selection with newlines can't pass itself off as
 * another field, such as a different tab id. The block holds facts only: how to
 * read a tab is in the system prompt, not inside fenced data.
 */
export function describeTab(tab: BrowserTab): string {
  const selection = tab.selection?.trim();
  const fields = {
    chromeProfile: tab.profile,
    tabId: tab.tabId,
    title: tab.title,
    url: contextUrl(tab.url),
    ...(selection ? { selectedText: selection } : {}),
  };
  return [
    "The user is writing from the Yarvis side panel in Chrome. The tab open beside it:",
    JSON.stringify(fields, null, 2),
  ].join("\n");
}

/**
 * Like the browser tools' tab listing: a query or fragment can carry a token,
 * so neither reaches the model. Other schemes give only their name, since a
 * `file:` path names local files and a `data:` URL is the page itself.
 */
function contextUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "";
  }
}

export function createBrowserChatRoutes(config: Config): Hono {
  const router = new Hono();

  router.use("*", async (c, next) => {
    if (!config.databaseUrl) return c.json({ error: "database not configured" }, 503);
    return next();
  });

  // The middleware above has already answered when there is no URL.
  const db = () => getDb(config.databaseUrl as string).db;

  // Only calls a panel turn asked about can be answered from here, so the
  // browser token can't decide an approval the in-app chat is waiting on.
  const askedHere = new Set<string>();

  router.get("/sessions", async (c) => {
    const sessions = await listSessions(db());
    return c.json(
      sessions.slice(0, MAX_SESSIONS).map(({ id, title, updatedAt }) => ({ id, title, updatedAt })),
    );
  });

  router.post("/sessions", async (c) => {
    const parsed = createSessionSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: "invalid session" }, 400);
    const { id, title, updatedAt } = await createSession(db(), parsed.data.title);
    return c.json({ id, title, updatedAt }, 201);
  });

  // Tool activity and metadata stay in the app: the panel shows the words.
  router.get("/sessions/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!z.string().uuid().safeParse(id).success) return c.json({ error: "invalid session" }, 400);
    const messages = (await getMessages(db(), id)).filter((m) => m.role !== "system");
    return c.json(
      newestThatFit(messages).map(({ id, role, content, createdAt }) => ({
        id,
        role,
        content,
        createdAt,
      })),
    );
  });

  router.post("/", async (c) => {
    const parsed = sendSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid message" }, 400);
    const { sessionId, message, tab } = parsed.data;

    // The panel has no model picker yet, so it uses the same default as Telegram.
    const choice = await defaultProviderModel(config);
    if (!choice) {
      return c.json({ error: "No LLM provider is configured. Add an API key in Settings." }, 400);
    }
    let model: Awaited<ReturnType<typeof resolveModel>>;
    try {
      model = await resolveModel(config, choice.provider, choice.model);
    } catch (e) {
      console.error("[browser] chat model resolution failed:", describeError(e));
      return c.json({ error: clientError(e) }, 400);
    }
    const budget = await getChatBudget(config, choice.provider, choice.model);
    const serverNames = new Map((await listMcpServers()).map((s) => [s.id, s.name]));

    return streamSSE(c, async (stream) => {
      // Approval requests are written from inside a tool's execute, beside the
      // event loop below, so every write goes through one chain to keep frames whole.
      let chain: Promise<void> = Promise.resolve();
      const write = (data: unknown): Promise<void> => {
        chain = chain.then(() => stream.writeSSE({ data: JSON.stringify(data) }));
        return chain;
      };
      const asked: string[] = [];
      try {
        // Tool results stay out of the stream: a page's text can be most of a
        // native message's 1 MiB, and the panel only shows tool names.
        for await (const event of runAgentTurn({
          config,
          db: db(),
          model,
          sessionId,
          message,
          context: tab ? describeTab(tab) : undefined,
          userMetadata: { source: "browser" },
          budget,
          serverNames,
          signal: c.req.raw.signal,
          approval: {
            signal: c.req.raw.signal,
            onRequest: async ({ toolCallId, id, args }) => {
              askedHere.add(toolCallId);
              asked.push(toolCallId);
              await write({
                type: "tool_approval_request",
                id: toolCallId,
                ...describeToolId(id, serverNames),
                args: previewArgs(args),
              });
            },
          },
        })) {
          if (event.type === "delta") await write({ type: "delta", text: event.text });
          else if (event.type === "tool_call") {
            await write({ type: "tool_call", id: event.id, name: event.name });
          } else if (event.type === "tool_result") {
            await write({ type: "tool_result", id: event.id, status: event.status });
          } else if (event.type === "attention") {
            await write({ type: "attention", reason: event.reason });
          } else if (event.type === "error") {
            await write({ type: "error", message: event.message });
          } else if (event.type === "done") {
            await write({ type: "done" });
          }
        }
      } finally {
        for (const id of asked) askedHere.delete(id);
      }
    });
  });

  router.post("/approvals/:toolCallId", async (c) => {
    const toolCallId = c.req.param("toolCallId");
    if (!askedHere.has(toolCallId)) return c.json({ error: "no such approval" }, 404);
    const parsed = approvalSchema.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: "invalid approval" }, 400);
    askedHere.delete(toolCallId);
    return c.json({ delivered: resolveApproval(toolCallId, parsed.data.approved) });
  });

  return router;
}
