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

/**
 * Longest title a chat takes from its first prompt. Counted in code points, as
 * Postgres counts them, so migration 0057's backfill cuts at the same place.
 */
export const PROMPT_TITLE_MAX = 60;

/**
 * A chat's name, taken from the first line of the prompt that opened it. Null
 * for a prompt with no text to show.
 *
 * Whitespace is the ASCII set spelled out, not `\s`: Postgres's `\s` depends
 * on the database's locale, and migration 0057 must name a chat exactly as this
 * does, or a rewind can't recognise the name to clear it.
 */
export function titleFromPrompt(prompt: string): string | null {
  const firstLine = prompt.match(/[^ \t\n\r\f\v][^\n]*/)?.[0];
  if (!firstLine) return null;
  const line = firstLine.replace(/[ \t\r\f\v]+/g, " ").replace(/ $/, "");
  // By code point, so an emoji at the cut is never split in half.
  const chars = Array.from(line);
  if (chars.length <= PROMPT_TITLE_MAX) return line;
  return `${chars
    .slice(0, PROMPT_TITLE_MAX - 1)
    .join("")
    .replace(/ $/, "")}…`;
}

/**
 * Whether this message is one the user wrote, and so may name its chat. A
 * scheduled task's prompt is model-written, and a heads-down pass's is the app's.
 */
function canNameChat(message: Pick<ChatMessage, "role" | "metadata">): boolean {
  return (
    message.role === "user" &&
    !message.metadata?.scheduledTask &&
    message.metadata?.source !== "heads-down"
  );
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
  // An untitled chat is named after the first prompt the user wrote.
  const title = canNameChat(row!) ? titleFromPrompt(input.content) : null;

  // Keep the session's updatedAt fresh so recent chats sort first. The database
  // supplies the timestamp rather than JS: the column is filled by `now()` on
  // insert, which keeps microseconds, while a `Date` truncates to milliseconds —
  // so a JS bump within the same millisecond as another session's creation
  // sorted the just-used session *below* it.
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
  // A rewind past the prompt that named the chat takes the name with it, or a
  // prompt the user took back would stay on screen and block the next one from
  // naming the chat. A title that came from anywhere else is left alone.
  for (const [index, message] of history.entries()) {
    const title = canNameChat(message) ? titleFromPrompt(message.content) : null;
    if (!title) continue;
    // The first prompt with a title is the one that named the chat.
    if (index >= at) {
      await db
        .update(chatSessions)
        .set({ title: null })
        .where(and(eq(chatSessions.id, sessionId), eq(chatSessions.title, title)));
    }
    break;
  }
  return true;
}
