/**
 * The merge reviewer in the sidecar writes agent reviews and reads reports;
 * the gate here reads agent reviews and writes reports. These check the two
 * sides agree, with real signatures checked by the real ssh-keygen.
 */

import { describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { parseReport, renderAgentReview } from "../../sidecar/src/verify/agentReview.ts";
import { sshPublicKey } from "../../sidecar/src/verify/sshsig.ts";
import { parseSignedAgentReview, reportDigest } from "./agentReview.ts";
import { renderReport, withSignature } from "./report.ts";
import {
  AGENT_REVIEW_NAMESPACE,
  allowedSignerLine,
  REPORT_NAMESPACE,
  verifiedSigner,
} from "./signing.ts";

const key = generateKeyPairSync("ed25519")
  .privateKey.export({ format: "der", type: "pkcs8" })
  .toString("base64");
const allowed = allowedSignerLine(
  "yarvis-merge-reviewer",
  sshPublicKey(key),
  AGENT_REVIEW_NAMESPACE,
);

const reportPayload = Buffer.from(JSON.stringify({ version: 2 })).toString("base64");
const reviewBody = renderAgentReview(
  {
    repo: "bennettaur/yarvis",
    pr: 7,
    headSha: "b".repeat(40),
    reportPayload,
    decision: "approve",
    reason: "The flagged branch is covered by the new test <script>.",
  },
  key,
);

describe("an agent review from the sidecar", () => {
  it("parses on the gate's side with the data it was given", () => {
    const review = parseSignedAgentReview(reviewBody);
    expect(review?.data).toEqual({
      version: 1,
      repo: "bennettaur/yarvis",
      pr: 7,
      headSha: "b".repeat(40),
      reportDigest: reportDigest(reportPayload),
      decision: "approve",
      reason: "The flagged branch is covered by the new test <script>.",
    });
  });

  it("carries a signature the gate's ssh-keygen check accepts", () => {
    const review = parseSignedAgentReview(reviewBody);
    if (!review) throw new Error("no review");
    expect(verifiedSigner(review.payload, review.signature, AGENT_REVIEW_NAMESPACE, allowed)).toBe(
      "yarvis-merge-reviewer",
    );
    // Its key is limited to agent reviews, so the same signature can't pass as a report's.
    expect(verifiedSigner(review.payload, review.signature, REPORT_NAMESPACE, allowed)).toBeNull();
  });

  it("keeps the model-written reason out of the comment's HTML", () => {
    expect(reviewBody).not.toContain("<script>");
  });
});

describe("a report from the gate's side", () => {
  it("parses in the sidecar with the same payload the gate signs", () => {
    const { body, data, payload } = renderReport(
      {
        goal: "g",
        summary: "s",
        verdict: "agent",
        verdictReason: "r",
        dimensions: Object.fromEntries(
          ["goal", "tests", "reliability", "security", "complexity", "maintainability", "ui"].map(
            (k) => [k, { status: "pass", note: "ok" }],
          ),
        ) as never,
        findings: [],
        screenshots: [],
        reviewers: [],
        model: "m",
      },
      {
        base: "a".repeat(40),
        head: "b".repeat(40),
        files: [],
        tier: { tier: "standard", reasons: [] },
        coverage: {
          changedLines: 0,
          coveredLines: 0,
          ratio: null,
          uncovered: [],
          notLoaded: [],
          unmeasured: [],
        },
        baseline: { detecting: 0, notDetecting: [], failingOnHead: [] },
        suites: [],
      },
      { repo: "bennettaur/yarvis", pr: 7 },
    );
    const parsed = parseReport(withSignature(body, "c2ln"));
    expect(parsed?.payload).toBe(payload);
    expect(parsed?.data).toMatchObject({
      repo: data.repo,
      pr: data.pr,
      headSha: data.headSha,
      verdict: "agent",
    });
  });
});
