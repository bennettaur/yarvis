import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { renderToHtml, textOf } from "../../../test/render";
import VerificationReportView from "./VerificationReportView";

const pass = { status: "pass" as const, findings: [] };

const report: VerificationReport = {
  summary: "Adds a cache in front of the user lookup.",
  mustRead: [
    { path: "src/cache.ts", reason: "Holds the eviction logic", lines: { start: 10, end: 40 } },
  ],
  risk: {
    level: "medium",
    clientImpact: "Stale profiles for up to a minute.",
    mitigations: ["Short TTL"],
    concerns: [
      {
        title: "No invalidation on write",
        detail: "Edits stay stale.",
        path: "src/cache.ts",
        line: 22,
      },
    ],
  },
  completeness: pass,
  tests: {
    status: "issues",
    findings: [
      {
        title: "Eviction is untested",
        detail: "Nothing covers a full cache.",
        severity: "high",
        path: "src/cache.test.ts",
      },
    ],
  },
  complexity: pass,
  performance: pass,
  comments: pass,
};

describe("VerificationReportView", () => {
  it("leads with the summary, then must-reads, risk and the checks", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    const order = ["Summary", "Must read", "Risk", "Checks"].map((h) => text.indexOf(h));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("src/cache.ts:10–40");
    expect(text).toContain("medium risk");
  });

  it("links only paths the PR has, and shows any other as plain text", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: (path) => path !== "src/cache.ts" },
      }),
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const buttons = [...host.querySelectorAll("button")].map((b) => b.textContent ?? "");
    expect(buttons.some((t) => t.includes("src/cache.ts"))).toBe(false);
    expect(host.textContent).toContain("src/cache.ts:10–40");
  });

  it("gives a passing check one line and a failing one its findings", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Completenesspasses");
    expect(text).toContain("Performancepasses");
    expect(text).toContain("Test quality1 finding");
    expect(text).toContain("Eviction is untested");
    expect(text).not.toContain("Test qualitypasses");
  });
});
