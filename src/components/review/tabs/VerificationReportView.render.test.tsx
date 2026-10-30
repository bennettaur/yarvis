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

  it("lists what already looks off in a must-read, each linking its line", async () => {
    const opened: [string, number | undefined][] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: {
          ...report,
          mustRead: [
            {
              ...report.mustRead[0],
              flags: [{ note: "TTL is read but never applied", line: 31 }, { note: "No line" }],
            },
          ],
        },
        onOpen: { open: (path, line) => opened.push([path, line]), canOpen: () => true },
      }),
    );
    try {
      const flags = host.querySelector('ul[aria-label="Looks off"]');
      expect(flags?.textContent).toContain("TTL is read but never applied");
      expect(flags?.textContent).toContain("No line");
      const link = [...(flags?.querySelectorAll("button") ?? [])];
      expect(link.map((b) => b.textContent)).toEqual(["src/cache.ts:31"]);
      link[0]?.click();
      expect(opened).toEqual([["src/cache.ts", 31]]);
    } finally {
      unmount();
    }
  });

  it("posts a finding on its line from an editable draft", async () => {
    const posted: { path: string; line: number; body: string }[] = [];
    const withLine: VerificationReport = {
      ...report,
      tests: {
        status: "issues",
        findings: [
          { ...report.tests.findings[0], line: 12 },
          { title: "No line", detail: "Whole PR.", severity: "low" },
        ],
      },
    };
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: withLine,
        onOpen: { open: () => {}, canOpen: () => true },
        onPostFinding: async ({ path, line }, body) => {
          posted.push({ path, line, body });
        },
      }),
    );
    const buttons = (label: string) =>
      [...host.querySelectorAll("button")].filter((b) => b.textContent === label);
    try {
      // Only the finding that cites a line can be posted.
      expect(buttons("Comment")).toHaveLength(1);
      buttons("Comment")[0]?.click();
      await new Promise((r) => setTimeout(r, 20));
      expect(host.querySelector("textarea")?.value).toBe(
        "**Eviction is untested**\n\nNothing covers a full cache.",
      );
      buttons("Post comment")[0]?.click();
      await new Promise((r) => setTimeout(r, 20));
      expect(posted).toEqual([
        {
          path: "src/cache.test.ts",
          line: 12,
          body: "**Eviction is untested**\n\nNothing covers a full cache.",
        },
      ]);
      expect(host.querySelector("textarea")).toBeNull();
      expect(host.textContent).toContain("Commented");
    } finally {
      unmount();
    }
  });

  it("offers no comment action without a way to post", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report: {
          ...report,
          tests: { ...report.tests, findings: [{ ...report.tests.findings[0], line: 12 }] },
        },
        onOpen: { open: () => {}, canOpen: () => true },
      }),
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const labels = [...host.querySelectorAll("button")].map((b) => b.textContent);
    expect(labels).not.toContain("Comment");
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

  it("shows the observability and quality checks, and leaves them out of a report without them", async () => {
    const withChecks = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: { ...report, observability: pass, quality: pass },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(withChecks).toContain("Observabilitypasses");
    expect(withChecks).toContain("Code qualitypasses");
    const withoutChecks = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(withoutChecks).not.toContain("Observability");
    expect(withoutChecks).not.toContain("Code quality");
  });

  it("crosses off must-reads and findings in files the reviewer has viewed", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report: {
          ...report,
          mustRead: [...report.mustRead, { path: "src/other.ts", reason: "Calls the cache" }],
        },
        onOpen: { open: () => {}, canOpen: () => true },
        viewed: new Set(["src/cache.ts"]),
      }),
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    expect(host.textContent).toContain("Must read · 1 of 2 viewed");
    const struck = [...host.querySelectorAll("li.line-through")].map((li) => li.textContent ?? "");
    // The must-read and the risk concern are in the viewed file; the test finding isn't.
    expect(struck.some((t) => t.includes("Holds the eviction logic"))).toBe(true);
    expect(struck.some((t) => t.includes("No invalidation on write"))).toBe(true);
    expect(struck.some((t) => t.includes("Calls the cache"))).toBe(false);
    expect(struck.some((t) => t.includes("Eviction is untested"))).toBe(false);
  });

  it("crosses off a check's finding once its file is viewed", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        viewed: new Set(["src/cache.test.ts"]),
      }),
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const struck = [...host.querySelectorAll("li.line-through")].map((li) => li.textContent ?? "");
    expect(struck.some((t) => t.includes("Eviction is untested"))).toBe(true);
  });
});
