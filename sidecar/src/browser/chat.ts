import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { runAgentTurn } from "../chat/agent.ts";
import { getChatBudget } from "../chat/config.ts";
import { createSession, getMessages, listSessions } from "../chat/service.ts";
import type { Config } from "../config.ts";
import { getDb } from "../db/client.ts";
import { clientError, describeError } from "../llm/errors.ts";
import { defaultProviderModel, resolveModel } from "../llm/providers.ts";

/**
 * Chat with the agent from the extension's side panel, mounted at
 * `/browser/chat` behind the browser bridge's host pin and scoped token.
 *
 * The panel is a typed surface, so a turn runs like one from the in-app chat
 * except that it has no way to ask for approval: MCP tools and the built-ins
 * that always confirm are left out of the turn rather than run unapproved.
 */

/** The panel shows recent sessions to pick from, not the whole history. */
const MAX_SESSIONS = 50;

/**
 * A native message to the extension is capped at 1 MiB, so a long thread is
 * sent from its newest end. The full thread is in the app.
 */
const MAX_THREAD_MESSAGES = 60;

const MAX_SELECTION_CHARS = 2_000;

/**
 * The tab beside the panel when the message was sent. The title, URL and
 * selection are written by the page, so they reach the model fenced as data.
 */
const tabSchema = z.object({
  tabId: z.number().int().nonnegative(),
  url: z.string().max(2_000),
  title: z.string().max(500),
  selection: z
    .string()
    .transform((text) => text.slice(0, MAX_SELECTION_CHARS))
    .optional(),
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
    url: withoutQuery(tab.url),
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
function withoutQuery(url: string): string {
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

  const db = () => getDb(config.databaseUrl as string).db;

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
      messages
        .slice(-MAX_THREAD_MESSAGES)
        .map(({ id, role, content, createdAt }) => ({ id, role, content, createdAt })),
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

    return streamSSE(c, async (stream) => {
      const write = (data: unknown) => stream.writeSSE({ data: JSON.stringify(data) });
      // Tool arguments and results stay out of the stream: a page's text can be
      // most of a native message's 1 MiB, and the panel only shows tool names.
      // No `approval` hooks on purpose: with nothing to prompt on, the turn drops
      // MCP tools and the always-confirm built-ins instead of running them.
      for await (const event of runAgentTurn({
        config,
        db: db(),
        model,
        sessionId,
        message,
        context: tab ? describeTab(tab) : undefined,
        userMetadata: { source: "browser" },
        budget,
        signal: c.req.raw.signal,
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
    });
  });

  return router;
}
