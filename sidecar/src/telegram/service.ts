import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type TelegramChat, telegramChats } from "../db/schema.ts";

/**
 * Persistence for the Telegram → Yarvis session mapping. Each Telegram chat
 * points at the Yarvis session it is currently talking to and, optionally, the
 * provider/model it replies with. The row survives sidecar restarts so a
 * conversation resumes where it left off.
 */

/** Returns the full mapping row for a Telegram chat, or null if none yet. */
export async function getChatState(db: Db, chatId: number): Promise<TelegramChat | null> {
  const [row] = await db
    .select()
    .from(telegramChats)
    .where(eq(telegramChats.chatId, chatId))
    .limit(1);
  return row ?? null;
}

/**
 * Points a Telegram chat at a session, inserting the mapping on first contact
 * and bumping `updatedAt` thereafter. Used by `/new-chat`, `/switch`, and the
 * lazy session creation on the first plain message.
 */
export async function setActiveSession(db: Db, chatId: number, sessionId: string): Promise<void> {
  await db
    .insert(telegramChats)
    .values({ chatId, activeSessionId: sessionId })
    .onConflictDoUpdate({
      target: telegramChats.chatId,
      set: { activeSessionId: sessionId, updatedAt: new Date() },
    });
}

/**
 * Sets the provider/model a Telegram chat replies with, inserting the mapping
 * on first contact. Used by `/setmodel`.
 */
export async function setProviderModel(
  db: Db,
  chatId: number,
  provider: string,
  model: string,
): Promise<void> {
  await db
    .insert(telegramChats)
    .values({ chatId, provider, model })
    .onConflictDoUpdate({
      target: telegramChats.chatId,
      set: { provider, model, updatedAt: new Date() },
    });
}
