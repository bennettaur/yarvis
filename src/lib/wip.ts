import { ensureOk, sidecarFetch } from "./api";
import type { AttentionNavTarget } from "./attention";

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
