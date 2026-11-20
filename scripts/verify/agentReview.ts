/**
 * The comment the Yarvis merge reviewer posts after reading a PR whose
 * report asked for an agent's review. The gate approves on it only when it
 * is signed by a key allowed for agent reviews and names the exact signed
 * report it read, so a review can't be carried over to a later report.
 *
 * The sidecar writes this format in `sidecar/src/verify/agentReview.ts`, and
 * `agentReview.test.ts` checks the two agree.
 */

import { createHash } from "node:crypto";
import { z } from "zod";

export const AGENT_REVIEW_MARKER = "<!-- yarvis-agent-review -->";

/** Begins the bot's approval when it acts on an agent review. `mergePath` reads it back. */
export const AGENT_APPROVAL_PREFIX = "Agent-approved:";

const SIGNED_PATTERN =
  /<!-- yarvis-agent-review-data ([A-Za-z0-9+/=]+) -->\s*<!-- yarvis-agent-review-sig ([A-Za-z0-9+/=]+) -->\s*$/;

const AgentReviewData = z.object({
  version: z.literal(1),
  repo: z.string(),
  pr: z.number().int().positive(),
  headSha: z.string(),
  /** When it was signed, ISO 8601, so a re-posted old review can be refused. */
  issuedAt: z.string().datetime(),
  /** SHA-256 of the signed report's data block (its base64 text), in hex. */
  reportDigest: z.string().regex(/^[0-9a-f]{64}$/),
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(300),
});
export type AgentReviewData = z.infer<typeof AgentReviewData>;

/** What an agent review's `reportDigest` must equal for a report's data block. */
export function reportDigest(reportPayload: string): string {
  return createHash("sha256").update(reportPayload).digest("hex");
}

export interface SignedAgentReview {
  data: AgentReviewData;
  /** The data block's base64 text, which is what was signed. */
  payload: string;
  signature: string;
}

/** Reads a signed agent review from a comment. It doesn't check the signature. */
export function parseSignedAgentReview(body: string): SignedAgentReview | null {
  const match = body.match(SIGNED_PATTERN);
  if (!match) return null;
  try {
    const parsed = AgentReviewData.safeParse(
      JSON.parse(Buffer.from(match[1], "base64").toString("utf8")),
    );
    return parsed.success ? { data: parsed.data, payload: match[1], signature: match[2] } : null;
  } catch {
    return null;
  }
}
