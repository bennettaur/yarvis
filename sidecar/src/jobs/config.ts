import { desc, eq } from "drizzle-orm";
import type { Db } from "../db/client.ts";
import { jobConfig } from "../db/schema.ts";

/**
 * Consent settings for the background jobs. Singleton, following
 * `wip/config.ts`: at most one row, most recent wins, defaults when absent.
 */

export interface JobConfig {
  /** Whether the Claude Code transcript digest may run at all. */
  ccDigestEnabled: boolean;
  /** Project directories it may read. Empty means none — see below. */
  ccDigestProjectDirs: string[];
}

/**
 * Off, with nothing allowed. The digest is the one job that sends local data to
 * an LLM provider, so both the switch and the directory list are opt-in: an
 * empty allowlist digests nothing rather than everything, which keeps "enabled"
 * from quietly meaning "all of `~/.claude`".
 */
export const DEFAULT_JOB_CONFIG: JobConfig = {
  ccDigestEnabled: false,
  ccDigestProjectDirs: [],
};

export async function getJobConfig(db: Db): Promise<JobConfig> {
  const [row] = await db.select().from(jobConfig).orderBy(desc(jobConfig.updatedAt)).limit(1);
  if (!row) return DEFAULT_JOB_CONFIG;
  return {
    ccDigestEnabled: row.ccDigestEnabled,
    ccDigestProjectDirs: row.ccDigestProjectDirs ?? [],
  };
}

/** Upserts the singleton, keeping the table to one row. */
export async function saveJobConfig(db: Db, input: JobConfig): Promise<JobConfig> {
  const values = {
    ccDigestEnabled: input.ccDigestEnabled,
    ccDigestProjectDirs: input.ccDigestProjectDirs,
    updatedAt: new Date(),
  };
  const [existing] = await db.select({ id: jobConfig.id }).from(jobConfig).limit(1);
  if (existing) {
    await db.update(jobConfig).set(values).where(eq(jobConfig.id, existing.id));
  } else {
    await db.insert(jobConfig).values(values);
  }
  return getJobConfig(db);
}
