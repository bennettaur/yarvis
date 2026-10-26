import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, renderToHtml, textOf } from "../../../test/render";
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

  it("leads with the files the checks didn't read, each opening its diff", async () => {
    const notExamined = Array.from({ length: 8 }, (_, i) => ({
      path: `zz/f${i}.ts`,
      reason: i === 0 ? "only 800 of its patch's 2400 lines were read" : "its patch wasn't opened",
    }));
    const opened: string[] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: {
          ...report,
          coverage: {
            examined: 10,
            total: 20,
            notExamined,
            skimmed: [
              { path: "package-lock.json", kind: "lockfile" },
              { path: "web/api.gen.ts", kind: "generated" },
            ],
            laneGaps: [{ check: "Performance", paths: ["src/cache.ts"] }],
          },
        },
        onOpen: { open: (path) => opened.push(path), canOpen: () => true },
      }),
    );
    try {
      const text = textOf(host.innerHTML);
      expect(text.indexOf("Not examined")).toBeLessThan(text.indexOf("Summary"));
      expect(text).toContain("No check read 8 of the 20 files changed.");
      expect(text).toContain("only 800 of its patch's 2400 lines were read");
      // Past six, the rest fold away behind a count.
      expect(
        host.querySelector('section[aria-label="Not examined"] details')?.textContent,
      ).toContain("2 more");
      // Skimmed bulk is its own folded group, with a count.
      expect(text).toContain("Generated, skimmed: 2 files");
      expect(text).toContain("Not examined by Performance: src/cache.ts");
      const first = [...host.querySelectorAll("button")].find((b) => b.textContent === "zz/f0.ts");
      first?.click();
      expect(opened).toEqual(["zz/f0.ts"]);
    } finally {
      unmount();
    }
  });

  it("says plainly when every file was read, and when it can't tell", async () => {
    const all = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            coverage: {
              examined: 19,
              total: 20,
              notExamined: [],
              skimmed: [{ path: "yarn.lock", kind: "lockfile" }],
              laneGaps: [],
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(all).toContain(
      "At least one check read each of the 19 files to read, and skimmed 1 file.",
    );
    expect(all).not.toContain("Not examined");
    const unknown = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: { ...report, coverage: { unknown: true } },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(unknown).toContain("couldn't count which files the checks read");
    const old = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(old).toContain("doesn't record which files its checks read");
    expect(old).not.toContain("read all");
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
