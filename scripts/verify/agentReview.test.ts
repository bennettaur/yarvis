/**
 * The merge reviewer in the sidecar writes agent reviews and reads reports;
 * the gate here reads agent reviews and writes reports. These check the two
 * sides agree, with real signatures checked by the real ssh-keygen.
 */

import { afterAll, describe, expect, it } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseReport, renderAgentReview } from "../../sidecar/src/verify/agentReview.ts";
import { sshPublicKey, sshSign } from "../../sidecar/src/verify/sshsig.ts";
import { parseSignedAgentReview, reportDigest } from "./agentReview.ts";
import { run } from "./exec.ts";
import { AGENT_PRINCIPAL, signatureChecks } from "./gate.ts";
import { renderReport, withSignature } from "./report.ts";
import {
  AGENT_REVIEW_NAMESPACE,
  allowedSignerLine,
  REPORT_NAMESPACE,
  signPayload,
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
    now: new Date("2026-10-24T12:00:00.000Z"),
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
      issuedAt: "2026-10-24T12:00:00.000Z",
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

  it("shows the model-written reason as code, so nothing in it renders", () => {
    expect(reviewBody).toContain("`The flagged branch is covered by the new test ‹script›.`");
  });

  it("keeps a line ending of any kind from closing the code span", () => {
    const body = renderAgentReview(
      {
        repo: "bennettaur/yarvis",
        pr: 7,
        headSha: "b".repeat(40),
        reportPayload,
        decision: "reject",
        reason: "x\r> ![a](https://example.test/?d=1)\u2028y",
      },
      key,
    );
    const reasonLine = body.split("\n").find((line) => line.startsWith("`"));
    expect(reasonLine).toBe("`x › ![a](https://example.test/?d=1) y`");
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
        risk: { tier: "standard", reasons: ["Changes how recall ranks memories"] },
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
          noTestsRan: [],
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

describe("signatureChecks, with real keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "checks-test-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const maintainerKey = join(dir, "maintainer");
  run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", maintainerKey]);
  const maintainerPub = readFileSync(`${maintainerKey}.pub`, "utf8");
  const maintainer = { program: "ssh-keygen", key: maintainerKey };

  it("takes a report from the maintainer's key and a review from the reviewer's, not the reverse", () => {
    const checks = signatureChecks(
      [allowedSignerLine("verify-pr", maintainerPub, REPORT_NAMESPACE), allowed].join("\n"),
    );
    const review = parseSignedAgentReview(reviewBody);
    if (!review) throw new Error("no review");
    expect(checks.isReviewSigned(review.payload, review.signature)).toBe(true);
    expect(checks.isReportSigned(review.payload, review.signature)).toBe(false);

    const reportSig = signPayload("report", REPORT_NAMESPACE, maintainer);
    expect(checks.isReportSigned("report", reportSig)).toBe(true);
    const asReview = signPayload("report", AGENT_REVIEW_NAMESPACE, maintainer);
    expect(checks.isReviewSigned("report", asReview)).toBe(false);
  });

  it("only takes reports from a verify-pr principal, whatever else a key is listed as", () => {
    const renamed = `some-other-name ${sshPublicKey(key)}`;
    const signature = Buffer.from(sshSign("report", REPORT_NAMESPACE, key)).toString("base64");
    expect(signatureChecks(renamed).isReportSigned("report", signature)).toBe(false);
  });

  it("keeps the reviewer's key off reports even when its line has no namespace limit", () => {
    const unlimited = `${AGENT_PRINCIPAL} ${sshPublicKey(key)}`;
    const checks = signatureChecks(unlimited);
    const signature = Buffer.from(sshSign("report", REPORT_NAMESPACE, key)).toString("base64");
    expect(checks.isReportSigned("report", signature)).toBe(false);
  });
});
