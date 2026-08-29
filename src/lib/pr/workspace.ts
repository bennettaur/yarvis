import { ensureOk, sidecarFetch } from "../api";
import type { PrRef } from "./types";

/**
 * Opening a workspace on a pull request. Like the guide routes, this takes the
 * ref in the body rather than the path, so one call serves both providers.
 */

export interface PrWorkspace {
  workspaceId: string;
  name: string;
  /** True when the PR already had a workspace and this one was reused. */
  existing: boolean;
}

/**
 * Asks the sidecar for a workspace checked out on this PR's branch, creating
 * one if the PR has none. Returns as soon as the workspace exists — it is still
 * provisioning, which the workspace view shows once the caller opens it.
 */
export async function startWorkspaceForPr(ref: PrRef): Promise<PrWorkspace> {
  const res = await sidecarFetch("/api/pr/workspace", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref }),
  });
  // A short context: the sidecar's own message says what to do about it, and
  // the header has room for one line beside the button.
  await ensureOk(res, "start workspace");
  return res.json();
}
