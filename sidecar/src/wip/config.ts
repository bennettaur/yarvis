import type { WipSourcesConfig } from "../db/schema.ts";
import { readSection, withSection } from "../settings/store.ts";

/**
 * Singleton store for the work-in-progress roll-up configuration: which sources
 * are enabled, and the GitHub issue labels that drive the "labeled issues"
 * source. Lives at the `wipConfig` key in `~/.yarvis/settings.json`. When
 * nothing is stored, sensible defaults apply (all sources on, no label filter).
 */

export interface WipConfig {
  sources: WipSourcesConfig;
  issueLabels: string[];
}

const SETTINGS_KEY = "wipConfig";

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

/** Returns the stored config merged over defaults (so new source keys default on). */
export async function getWipConfig(): Promise<WipConfig> {
  const stored = await readSection<WipConfig>(SETTINGS_KEY);
  if (!stored) return DEFAULT_WIP_CONFIG;
  return {
    sources: { ...DEFAULT_WIP_SOURCES, ...stored.sources },
    issueLabels: stored.issueLabels ?? [],
  };
}

/** Stores the config as the whole section, replacing whatever was there before. */
export async function saveWipConfig(input: WipConfig): Promise<WipConfig> {
  await withSection<WipConfig, void>(SETTINGS_KEY, () => ({ next: input, result: undefined }));
  return getWipConfig();
}
