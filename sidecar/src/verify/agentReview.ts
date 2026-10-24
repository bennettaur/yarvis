import { createHash } from "node:crypto";
import { sshSign } from "./sshsig.ts";

/**
 * The comment the merge reviewer posts on a PR whose verification report asked
 * for an agent's review, and the report it reads. The repo's CI gate
 * (`scripts/verify/gate.ts`) reads this format back, and
 * `scripts/verify/agentReview.test.ts` checks the two agree: change both
 * together.
 */

export const AGENT_REVIEW_MARKER = "<!-- yarvis-agent-review -->";
export const REPORT_MARKER = "<!-- yarvis-verify -->";

/** The SSH signature namespace, which the repo limits this key to. */
export const AGENT_REVIEW_NAMESPACE = "yarvis-agent-review";

const REPORT_DATA =
  /<!-- yarvis-verify-data ([A-Za-z0-9+/=]+) -->\s*<!-- yarvis-verify-sig [A-Za-z0-9+/=]+ -->\s*$/;

/** The parts of a verification report's signed data the reviewer checks. */
export interface ReportData {
  repo: string;
  pr: number;
  headSha: string;
  verdict: "auto" | "agent" | "human";
}

export interface ParsedReport {
  data: ReportData;
  /** The data block's base64 text, which the review names by its SHA-256. */
  payload: string;
  /** The report as people read it, without its data and signature blocks. */
  text: string;
}

/**
 * Reads a posted verification report. It doesn't check the signature: the
 * gate does, and a review of an unsigned report is refused there.
 */
export function parseReport(body: string): ParsedReport | null {
  const match = body.match(REPORT_DATA);
  if (!match) return null;
  try {
    const data = JSON.parse(Buffer.from(match[1], "base64").toString("utf8"));
    if (
      data?.version !== 2 ||
      typeof data.repo !== "string" ||
      typeof data.pr !== "number" ||
      typeof data.headSha !== "string" ||
      !["auto", "agent", "human"].includes(data.verdict)
    ) {
      return null;
    }
    return { data, payload: match[1], text: body.slice(0, match.index).trim() };
  } catch {
    return null;
  }
}

export interface AgentReviewInput {
  repo: string;
  pr: number;
  headSha: string;
  /** The report's data block, exactly as posted. */
  reportPayload: string;
  decision: "approve" | "reject";
  /** One or two sentences, shown on the PR and kept in the signed data. */
  reason: string;
}

/** The comment's markdown, ending in its signed data block. */
export function renderAgentReview(input: AgentReviewInput, privateKey: string): string {
  const data = {
    version: 1,
    repo: input.repo,
    pr: input.pr,
    headSha: input.headSha,
    reportDigest: createHash("sha256").update(input.reportPayload).digest("hex"),
    decision: input.decision,
    reason: input.reason.slice(0, 300),
  };
  const payload = Buffer.from(JSON.stringify(data)).toString("base64");
  const signature = Buffer.from(sshSign(payload, AGENT_REVIEW_NAMESPACE, privateKey)).toString(
    "base64",
  );
  const title =
    input.decision === "approve"
      ? "🤖 Merge reviewer: approve"
      : "🤖 Merge reviewer: needs a human";
  // The reason is model-written: keep it on one line and out of HTML.
  const reason = data.reason.replace(/\r?\n/g, " ").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return [
    AGENT_REVIEW_MARKER,
    `## ${title}`,
    "",
    reason,
    "",
    `<sub>For \`${input.headSha.slice(0, 7)}\` and the verification report posted for it.</sub>`,
    `<!-- yarvis-agent-review-data ${payload} -->`,
    `<!-- yarvis-agent-review-sig ${signature} -->`,
  ].join("\n");
}
