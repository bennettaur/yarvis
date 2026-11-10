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

  it("shows the impact band, what to check, and every change behind a fold", async () => {
    const change = {
      kind: "logic" as const,
      reach: "core" as const,
      evidence: "partial" as const,
      sensitive: false,
      count: 1,
      path: "src/cache.ts",
      line: 22,
    };
    const scored: VerificationReport = {
      ...report,
      risk: {
        ...(report.risk as NonNullable<VerificationReport["risk"]>),
        level: "high",
        impact: {
          band: 4,
          highestChangeBand: 3,
          load: 9,
          raisedByVolume: 1,
          total: 2,
          counts: {
            passive: 4,
            reorganization: 0,
            addition: 0,
            removal: 0,
            interface: 0,
            logic: 2,
          },
          changes: [
            {
              ...change,
              title: "Serve lookups from the cache",
              check: "A write evicts the cached profile",
              band: 4,
            },
            { ...change, title: "Tidy comments", kind: "passive", count: 4, check: "", band: 1 },
          ],
        },
      },
    };
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: scored,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("high impact · 4/5");
    // The agent's level matches the band's, so it isn't shown twice.
    expect(text).not.toContain("high risk");
    expect(text).toContain("4 passive, 2 logic changes");
    expect(text).toContain("raised from moderate by the number of changes");
    expect(text).toContain("A write evicts the cached profile");
    expect(text).toContain("logic · core · partly tested");
    expect(text).toContain("Every change (2)");
    expect(text).toContain("passive · core · partly tested · 4 like it");
  });

  it("shows the agent's level beside the band when the agent judged it stricter", async () => {
    const risk = report.risk as NonNullable<VerificationReport["risk"]>;
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            risk: {
              ...risk,
              level: "high",
              impact: {
                band: 2,
                highestChangeBand: 2,
                load: 1,
                raisedByVolume: 0,
                total: 40,
                counts: {
                  passive: 0,
                  reorganization: 0,
                  addition: 1,
                  removal: 0,
                  interface: 0,
                  logic: 0,
                },
                changes: [
                  {
                    title: "Add a cache",
                    kind: "addition",
                    reach: "local",
                    evidence: "proven",
                    sensitive: false,
                    count: 1,
                    check: "",
                    band: 2,
                  },
                ],
              },
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("low impact · 2/5");
    expect(text).toContain("high risk");
    expect(text).not.toContain("Needs attention");
    expect(text).toContain("Every change (1 of 40)");
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
      const links = [...(flags?.querySelectorAll("button") ?? [])];
      expect(links.map((b) => b.textContent)).toEqual(["src/cache.ts:31"]);
      links[0]?.click();
      expect(opened).toEqual([["src/cache.ts", 31]]);
    } finally {
      unmount();
    }
  });

  it("shows no flag list for a must-read with nothing flagged", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report: { ...report, mustRead: [{ ...report.mustRead[0], flags: [] }] },
        onOpen: { open: () => {}, canOpen: () => true },
      }),
    );
    expect(html).not.toContain("Looks off");
  });

  it("shows a must-read from an older report, with no flags or range, as just its path", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: { ...report, mustRead: [{ path: "src/cache.ts", reason: "Eviction" }] },
        onOpen: { open: () => {}, canOpen: () => true },
      }),
    );
    try {
      expect(host.querySelector('ul[aria-label="Looks off"]')).toBeNull();
      const paths = [...host.querySelectorAll("button")].map((b) => b.textContent);
      expect(paths).toContain("src/cache.ts");
    } finally {
      unmount();
    }
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

  it("posts a finding with a location to the PR or the linked workspace, once each", async () => {
    const sent: string[] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        poster: {
          toPr: async (f, section) => {
            sent.push(`pr ${section} ${f.path}:${f.line}`);
          },
          toWorkspace: {
            name: "cache-work",
            add: async () => {
              throw new Error("workspace repo not found");
            },
          },
        },
      }),
    );
    try {
      const buttons = (label: string) =>
        [...host.querySelectorAll("button")].filter((b) => b.textContent === label);
      // Only the risk concern has a line; the test finding names no line.
      expect(buttons("Post to PR")).toHaveLength(1);
      buttons("Post to PR")[0]?.click();
      buttons("Add to cache-work")[0]?.click();
      await new Promise((r) => setTimeout(r, 20));
      expect(sent).toEqual(["pr Risk src/cache.ts:22"]);
      const posted = buttons("Posted to PR")[0];
      expect(posted?.disabled).toBe(true);
      expect(textOf(host.innerHTML)).toContain("workspace repo not found");
    } finally {
      unmount();
    }
  });

  it("shows only the sections a run was asked for, with the flow when it has one", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            summary: "Adds a cache.",
            mustRead: [],
            tests: pass,
            flow: {
              title: "How a lookup is cached",
              explanation: "Reads go through the cache.",
              mermaid: "",
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("How a lookup is cached");
    expect(text).toContain("Test quality");
    expect(text).not.toContain("Risk");
    expect(text).not.toContain("Performance");
    expect(text).not.toContain("Simpler approach");
  });

  it("rates the approach as a whole, with the simpler way and where it builds on", async () => {
    const opened: [string, number | undefined][] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: {
          summary: "Adds a cache.",
          mustRead: [],
          approach: {
            rating: "much-simpler",
            reason: "A second cache beside the one the client already has.",
            alternative: "Set a TTL on the existing request cache.",
            path: "src/client.ts",
            line: 12,
          },
        },
        onOpen: { open: (path, line) => opened.push([path, line]), canOpen: () => true },
      }),
    );
    try {
      const text = textOf(host.innerHTML);
      expect(text).toContain("A much simpler way exists");
      expect(text).toContain("Set a TTL on the existing request cache.");
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "src/client.ts:12",
      );
      link?.click();
      expect(opened).toEqual([["src/client.ts", 12]]);
    } finally {
      unmount();
    }
  });

  it("tells a simpler way apart from a much simpler one, by label and colour", async () => {
    const badgeFor = async (rating: "simpler" | "much-simpler") => {
      const { host, unmount } = await mountForInteraction(
        createElement(VerificationReportView, {
          report: {
            summary: "Adds a cache.",
            mustRead: [],
            approach: { rating, reason: "Two caches.", alternative: "Reuse the client cache." },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      );
      try {
        const badge = [...host.querySelectorAll("span")].find((s) =>
          s.textContent?.endsWith("simpler way exists"),
        );
        return { label: badge?.textContent, className: badge?.className };
      } finally {
        unmount();
      }
    };
    const simpler = await badgeFor("simpler");
    const much = await badgeFor("much-simpler");
    expect(simpler.label).toBe("A simpler way exists");
    expect(much.label).toBe("A much simpler way exists");
    expect(simpler.className).not.toBe(much.className);
  });

  it("says in a line when there is no simpler way", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            summary: "Adds a cache.",
            mustRead: [],
            approach: { rating: "no-simpler", reason: "Reuses the client cache.", alternative: "" },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("No simpler way found");
    expect(text).not.toContain("Simpler way:");
  });

  it("shows a failed rating as not rated, not as a verdict", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            summary: "Adds a cache.",
            mustRead: [],
            approach: {
              rating: "unrated",
              reason: "The approach agent failed to answer; judge the approach by hand.",
              alternative: "",
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Not rated");
    expect(text).not.toContain("simpler way exists");
  });
});
