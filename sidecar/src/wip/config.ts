import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { type WipSourcesConfig, wipConfig } from "../db/schema.ts";

/**
 * Singleton store for the work-in-progress roll-up configuration: which sources
 * are enabled, and the GitHub issue labels that drive the "labeled issues"
 * source. Modeled on the embeddings-config singleton — at most one row, most
 * recent wins. When no row exists, sensible defaults apply (all sources on, no
 * label filter).
 */

export interface WipConfig {
  sources: WipSourcesConfig;
  issueLabels: string[];
}

/** All sources on — the roll-up shows everything until the user narrows it. */
export const DEFAULT_WIP_SOURCES: WipSourcesConfig = {
  myPrs: true,
  starredPrs: true,
  issues: true,
  tasks: true,
  workspaces: true,
};

export const DEFAULT_WIP_CONFIG: WipConfig = {
  sources: DEFAULT_WIP_SOURCES,
  issueLabels: [],
};

/** Returns the saved config merged over defaults (so new source keys default on). */
export async function getWipConfig(db: Db): Promise<WipConfig> {
  const [row] = await db.select().from(wipConfig).orderBy(desc(wipConfig.updatedAt)).limit(1);
  if (!row) return DEFAULT_WIP_CONFIG;
  return {
    sources: { ...DEFAULT_WIP_SOURCES, ...row.sources },
    issueLabels: row.issueLabels ?? [],
  };
}

/** Upserts the singleton config, keeping the table to one row. */
export async function saveWipConfig(db: Db, input: WipConfig): Promise<WipConfig> {
  const values = { sources: input.sources, issueLabels: input.issueLabels, updatedAt: new Date() };
  const [existing] = await db.select({ id: wipConfig.id }).from(wipConfig).limit(1);
  if (existing) {
    await db.update(wipConfig).set(values).where(eq(wipConfig.id, existing.id));
  } else {
    await db.insert(wipConfig).values(values);
  }
  return getWipConfig(db);
}
