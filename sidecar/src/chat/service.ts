import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import {
  type ChatMessage,
  type ChatMessageMetadata,
  type ChatSession,
  chatMessages,
  chatSessions,
  type ToolActivity,
} from "../db/schema.ts";
import { emitEvent } from "../events/service.ts";

/** Chat session + message persistence. */

/**
 * Starts a chat session. A hidden one (a heads-down pass) stays out of the
 * chat list and the activity log, since the user didn't start a conversation.
 */
export async function createSession(
  db: Db,
  title?: string | null,
  options: { hidden?: boolean } = {},
): Promise<ChatSession> {
  const hidden = options.hidden ?? false;
  const [row] = await db
    .insert(chatSessions)
    .values({ title: title ?? null, hidden })
    .returning();
  if (hidden) return row!;
  await emitEvent(db, {
    type: "chat.started",
    source: "chat",
    payload: { sessionId: row!.id },
  });
  return row!;
}

export async function listSessions(db: Db): Promise<ChatSession[]> {
  return db
    .select()
    .from(chatSessions)
    .where(eq(chatSessions.hidden, false))
    .orderBy(desc(chatSessions.updatedAt));
}

export async function getMessages(db: Db, sessionId: string): Promise<ChatMessage[]> {
  return db
    .select()
    .from(chatMessages)
    .where(eq(chatMessages.sessionId, sessionId))
    .orderBy(asc(chatMessages.createdAt));
}

export interface AddMessageInput {
  sessionId: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  /** What the assistant ran during the turn this message concluded. */
  toolCalls?: ToolActivity[];
  metadata?: ChatMessageMetadata;
}

/** Longest title a chat takes from its first prompt, in characters. */
export const PROMPT_TITLE_MAX = 60;

/**
 * A chat's name, taken from the first line of the prompt that opened it. Null
 * for a prompt with no text to show.
 */
export function titleFromPrompt(prompt: string): string | null {
  const line = prompt
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .find((l) => l.length > 0);
  if (!line) return null;
  if (line.length <= PROMPT_TITLE_MAX) return line;
  return `${line.slice(0, PROMPT_TITLE_MAX - 1).trimEnd()}…`;
}

export async function addMessage(db: Db, input: AddMessageInput): Promise<ChatMessage> {
  const [row] = await db
    .insert(chatMessages)
    .values({
      sessionId: input.sessionId,
      role: input.role,
      content: input.content,
      toolCalls: input.toolCalls ?? null,
      metadata: input.metadata ?? null,
    })
    .returning();
  // Keep the session's updatedAt fresh so recent chats sort first. The database
  // supplies the timestamp rather than JS: the column is filled by `now()` on
  // insert, which keeps microseconds, while a `Date` truncates to milliseconds —
  // so a JS bump within the same millisecond as another session's creation
  // sorted the just-used session *below* it.
  // An untitled chat is named after the first prompt the user wrote. A
  // scheduled task's prompt is model-written, so it never names one.
  const title =
    input.role === "user" && !input.metadata?.scheduledTask ? titleFromPrompt(input.content) : null;
  await db
    .update(chatSessions)
    .set({
      updatedAt: sql`now()`,
      ...(title ? { title: sql`coalesce(${chatSessions.title}, ${title})` } : {}),
    })
    .where(eq(chatSessions.id, input.sessionId));
  return row!;
}

/**
 * Drops a user message and everything after it, so the conversation can restart
 * from that point. Returns false — deleting nothing — when the id isn't a user
 * message in this session: only a turn the user wrote can be replayed, and a
 * client must not be able to reach into another session's history.
 */
export async function rewindToMessage(
  db: Db,
  sessionId: string,
  messageId: string,
): Promise<boolean> {
  // Cut by position in the transcript getMessages returns, not by comparing
  // timestamps: rows written in the same instant would otherwise be over- or
  // under-deleted.
  const history = await getMessages(db, sessionId);
  const at = history.findIndex((m) => m.id === messageId);
  if (at === -1 || history[at]!.role !== "user") return false;
  await db.delete(chatMessages).where(
    and(
      eq(chatMessages.sessionId, sessionId),
      inArray(
        chatMessages.id,
        history.slice(at).map((m) => m.id),
      ),
    ),
  );
  return true;
}
