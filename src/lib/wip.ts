import { ensureOk, sidecarFetch } from "./api";
import type { AttentionNavTarget } from "./attention";

/** Which WIP sources are enabled (mirrors the sidecar `WipSourcesConfig`). */
export interface WipSourcesConfig {
  myPrs: boolean;
  starredPrs: boolean;
  issues: boolean;
  tasks: boolean;
  workspaces: boolean;
}

export interface WipConfig {
  sources: WipSourcesConfig;
  /** Labels driving the "labeled issues" source (open GitHub issues assigned to you). */
  issueLabels: string[];
}

/**
 * The work-in-progress stream: an ambient, prioritized roll-up of what the user
 * has open — PRs, issues, tasks, workspaces — aggregated read-only by the
 * sidecar from existing data. Distinct from the attention stream (things that
 * need the user *now*); this is the "still in flight" backlog.
 */

export type WipSource = "pr" | "starred-pr" | "issue" | "task" | "workspace";

export interface WipItem {
  id: string;
  source: WipSource;
  title: string;
  subtitle: string | null;
  navTarget: AttentionNavTarget | null;
}

/** Fetches the prioritized WIP list. Returns [] when nothing is configured. */
export async function getWip(): Promise<WipItem[]> {
  const res = await sidecarFetch("/api/wip");
  await ensureOk(res, "list work-in-progress");
  return res.json();
}

/** Reads the saved WIP config (source toggles + issue labels). */
export async function getWipConfig(): Promise<WipConfig> {
  const res = await sidecarFetch("/api/wip/config");
  await ensureOk(res, "read work-in-progress config");
  return res.json();
}

/** Persists the WIP config; returns the stored value. */
export async function saveWipConfig(config: WipConfig): Promise<WipConfig> {
  const res = await sidecarFetch("/api/wip/config", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(config),
  });
  await ensureOk(res, "save work-in-progress config");
  return res.json();
}
