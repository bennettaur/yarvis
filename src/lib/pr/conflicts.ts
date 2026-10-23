import { ensureOk, sidecarFetch } from "../api";
import type { PrDetail, PrRef } from "./types";

/**
 * Whether an open pull request conflicts with its base, from the detail both
 * providers fill in. `computing` is GitHub (or Azure) not having worked it out
 * yet — GitHub computes mergeability lazily, on the first read after a push —
 * which is worth one more look shortly but nothing on screen.
 */
export type PrConflictState = "conflicts" | "computing" | "none";

const TERMINAL_STATES = new Set(["merged", "closed", "completed", "abandoned"]);

export function prConflictState(detail: PrDetail | null): PrConflictState {
  if (!detail) return "none";
  if (TERMINAL_STATES.has(detail.state.toLowerCase())) return "none";
  // GitHub can report DIRTY while `mergeable` is still settling, so either
  // naming conflicts is enough.
  if (detail.mergeable === "CONFLICTING") return "conflicts";
  if ((detail.mergeStateStatus ?? "").toUpperCase() === "DIRTY") return "conflicts";
  if (detail.mergeable === "UNKNOWN") return "computing";
  return "none";
}

/**
 * What became of a request to resolve a PR's conflicts. `needs_confirm` means
 * nothing was sent: the agent looked busy, and the request must be repeated
 * with `confirm` to interrupt it.
 */
export type ResolveConflictsResult =
  | { outcome: "sent" | "started" | "created"; workspaceId: string; name: string }
  | { outcome: "needs_confirm"; workspaceId: string; name: string; reason: string };

/** Hands the PR's conflicts to a coding agent; see `POST /api/pr/resolve-conflicts`. */
export async function resolvePrConflicts(
  ref: PrRef,
  confirm = false,
): Promise<ResolveConflictsResult> {
  const res = await sidecarFetch("/api/pr/resolve-conflicts", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, confirm }),
  });
  await ensureOk(res, "resolve conflicts");
  return res.json();
}
