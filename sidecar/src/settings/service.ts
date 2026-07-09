import { eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { appSettings } from "../db/schema.ts";

export const CLAUDE_COMMAND_KEY = "claude_command";

export async function getSetting(db: Db, key: string): Promise<string | null> {
  const [row] = await db.select().from(appSettings).where(eq(appSettings.key, key));
  return row?.value ?? null;
}

export async function setSetting(db: Db, key: string, value: string): Promise<void> {
  await db
    .insert(appSettings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: appSettings.key,
      set: { value, updatedAt: new Date() },
    });
}
