import { readSection, withSection } from "../settings/store.ts";

/**
 * Consent settings for the background jobs, stored under the `jobConfig` key
 * in `~/.yarvis/settings.json`. Singleton: defaults apply when nothing is
 * stored.
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

const SETTINGS_KEY = "jobConfig";

export async function getJobConfig(): Promise<JobConfig> {
  const stored = await readSection<JobConfig>(SETTINGS_KEY);
  return stored ?? DEFAULT_JOB_CONFIG;
}

export async function saveJobConfig(input: JobConfig): Promise<JobConfig> {
  return withSection<JobConfig, JobConfig>(SETTINGS_KEY, () => ({
    next: input,
    result: input,
  }));
}
