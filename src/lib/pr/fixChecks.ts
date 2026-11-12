import { ensureOk, sidecarFetch } from "../api";
import type { AgentHandOffResult } from "./conflicts";
import type { CheckItem, PrRef } from "./types";

/**
 * Conclusions the sidecar hands to an agent as failures: the "failed" case of
 * `checkOutcome` in sidecar/src/reviewWorkspaces/verification.ts. The two are
 * kept in step by hand, and both sides' tests check the same table.
 */
const FAILED_CONCLUSIONS = new Set([
  "FAILURE",
  "ERROR",
  "TIMED_OUT",
  "STARTUP_FAILURE",
  "ACTION_REQUIRED",
]);

/** True for a check that finished and failed; running, skipped and cancelled ones are not. */
export function isFailingCheck(check: CheckItem): boolean {
  return FAILED_CONCLUSIONS.has((check.conclusion ?? "").toUpperCase());
}

/** Hands the PR's failing checks to a coding agent; see `POST /api/pr/fix-checks`. */
export async function fixPrChecks(ref: PrRef, confirm = false): Promise<AgentHandOffResult> {
  const res = await sidecarFetch("/api/pr/fix-checks", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ref, confirm }),
  });
  await ensureOk(res, "fix failing checks");
  return res.json();
}
