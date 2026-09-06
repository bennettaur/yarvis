import { asc, desc, eq, sql } from "drizzle-orm";
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

export async function createSession(db: Db, title?: string | null): Promise<ChatSession> {
  const [row] = await db
    .insert(chatSessions)
    .values({ title: title ?? null })
    .returning();
  await emitEvent(db, {
    type: "chat.started",
    source: "chat",
    payload: { sessionId: row!.id },
  });
  return row!;
}

export async function listSessions(db: Db): Promise<ChatSession[]> {
  return db.select().from(chatSessions).orderBy(desc(chatSessions.updatedAt));
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
  await db
    .update(chatSessions)
    .set({ updatedAt: sql`now()` })
    .where(eq(chatSessions.id, input.sessionId));
  return row!;
}
