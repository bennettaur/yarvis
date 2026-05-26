import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { omniLayouts, type OmniLayout } from "../db/schema.ts";

/**
 * Persistence for named Omni layouts. A layout is a json-render spec the user
 * built in the Omni view and wants to reload later. Saving is upsert-by-name so
 * re-saving an existing name overwrites it rather than accumulating duplicates.
 */

export async function listLayouts(db: Db): Promise<OmniLayout[]> {
  return db.select().from(omniLayouts).orderBy(desc(omniLayouts.updatedAt));
}

export async function getLayout(db: Db, id: string): Promise<OmniLayout | null> {
  const [row] = await db.select().from(omniLayouts).where(eq(omniLayouts.id, id));
  return row ?? null;
}

export async function saveLayout(
  db: Db,
  name: string,
  spec: unknown,
): Promise<OmniLayout> {
  const [existing] = await db
    .select()
    .from(omniLayouts)
    .where(eq(omniLayouts.name, name));

  if (existing) {
    const [row] = await db
      .update(omniLayouts)
      .set({ spec, updatedAt: new Date() })
      .where(eq(omniLayouts.id, existing.id))
      .returning();
    return row!;
  }

  const [row] = await db.insert(omniLayouts).values({ name, spec }).returning();
  return row!;
}

export async function deleteLayout(db: Db, id: string): Promise<boolean> {
  const rows = await db
    .delete(omniLayouts)
    .where(eq(omniLayouts.id, id))
    .returning();
  return rows.length > 0;
}
