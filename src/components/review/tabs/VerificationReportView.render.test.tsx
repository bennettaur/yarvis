import { afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { VerificationReport } from "../../../lib/reviewWorkspaces/verification";
import { mountForInteraction, renderToHtml, textOf, waitFor } from "../../../test/render";
import { resetReviewApi, stubReviewApi } from "../../../test/reviewWorkspacesApi";
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
  it("puts bugs under whether it is safe to ship, and improvements under the quality bar", async () => {
    const finding = (title: string) => ({
      status: "issues" as const,
      findings: [{ title, detail: "d", severity: "medium" as const, path: "src/a.ts", line: 1 }],
    });
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            bugs: finding("A second save drops the first"),
            improvements: finding("Capture the selection, not the screen"),
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    const safety = text.indexOf("Is it safe to ship?");
    const quality = text.indexOf("Does it meet the quality bar?");
    const bug = text.indexOf("A second save drops the first");
    const idea = text.indexOf("Capture the selection, not the screen");
    expect(safety).toBeGreaterThanOrEqual(0);
    expect(bug).toBeGreaterThan(safety);
    expect(bug).toBeLessThan(quality);
    expect(idea).toBeGreaterThan(quality);
    expect(text).toContain("Refactors and design changes the PR points to");
  });

  it("groups the sections under the questions a review answers, each saying what it is for", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    const order = [
      "What is it trying to do?",
      "Summary",
      "Must read",
      "Is it safe to ship?",
      "Risk",
      "Test quality",
      "Does it meet the quality bar?",
      "Complexity",
    ].map((h) => text.indexOf(h));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // No claims or malice result, so neither question is shown.
    expect(text).not.toContain("Does it do what it claims?");
    expect(text).not.toContain("Anything malicious or unrelated?");
    expect(text).toContain("The files where your reading can change the outcome.");
    expect(text).toContain("Whether the tests would catch a mistake in this change.");
    expect(text).toContain("src/cache.ts:10–40");
    expect(text).toContain("medium risk");
    // A report from before mitigations named a risk still shows its bare one.
    expect(text).toContain("Other mitigations in the PR:Short TTL");
  });

  describe("a must-read's diff snippet", () => {
    const patch = [
      "@@ -8,4 +8,5 @@",
      " before",
      "-old eviction",
      "+new eviction",
      "+evict on write",
      " after",
      "@@ -40,2 +41,2 @@",
      "-far away",
      "+elsewhere",
    ].join("\n");
    let sha = 0;
    /** A fresh head per test, so the diff cache never answers from another test. */
    const source = () => ({
      workspaceId: "ws",
      pr: { id: "pr", headSha: `head${++sha}`, mergeBaseSha: "base" },
    });
    const mustRead = {
      ...report,
      mustRead: [
        {
          path: "src/cache.ts",
          reason: "Does a write evict the cached profile?",
          why: "Users would see their old profile after editing it.",
          lines: { start: 9, end: 10 },
        },
      ],
    };
    const snippetOf = (host: HTMLElement) => {
      const details = [...host.querySelectorAll("details")].find((d) =>
        d.textContent?.includes("Show the diff"),
      );
      if (!details) throw new Error("no diff snippet");
      return details;
    };
    const toggle = (details: HTMLDetailsElement, open: boolean) => {
      details.open = open;
      details.dispatchEvent(new Event("toggle"));
    };

    afterEach(() => resetReviewApi());

    it("asks the question, says why it matters, and shows only the hunks for its lines", async () => {
      const asked: string[] = [];
      stubReviewApi({
        reviewFileDiff: async (_ws, _pr, path) => {
          asked.push(path);
          return { path, patch, tooLarge: false, headSha: "h", mergeBaseSha: "b" };
        },
      });
      const { host, unmount } = await mountForInteraction(
        createElement(VerificationReportView, {
          report: mustRead,
          onOpen: { open: () => {}, canOpen: () => true },
          diffSource: source(),
        }),
      );
      try {
        const text = textOf(host.innerHTML);
        expect(text).toContain("Answer while reading: Does a write evict the cached profile?");
        expect(text).toContain(
          "Why it matters: Users would see their old profile after editing it.",
        );
        // Nothing is read until the snippet is opened.
        expect(asked).toEqual([]);
        const details = snippetOf(host);
        toggle(details, true);
        await waitFor(() => !!details.querySelector("pre"), "the snippet");
        const shown = details.querySelector("pre")?.textContent ?? "";
        expect(shown).toContain("+new eviction");
        expect(shown).toContain("-old eviction");
        expect(shown).not.toContain("elsewhere");
        // Closing and opening again reads from the cache.
        toggle(details, false);
        await waitFor(() => !details.querySelector("pre"), "the snippet closed");
        toggle(details, true);
        await waitFor(() => !!details.querySelector("pre"), "the snippet again");
        expect(asked).toEqual(["src/cache.ts"]);
      } finally {
        unmount();
      }
    });

    it("says when the diff can't be read, and asks again when reopened", async () => {
      let calls = 0;
      stubReviewApi({
        reviewFileDiff: async () => {
          calls += 1;
          throw new Error("sidecar is down");
        },
      });
      const { host, unmount } = await mountForInteraction(
        createElement(VerificationReportView, {
          report: mustRead,
          onOpen: { open: () => {}, canOpen: () => true },
          diffSource: source(),
        }),
      );
      try {
        const details = snippetOf(host);
        toggle(details, true);
        await waitFor(() => !!details.textContent?.includes("Couldn't load the diff."), "error");
        toggle(details, false);
        await waitFor(() => !details.textContent?.includes("Couldn't load"), "the snippet closed");
        toggle(details, true);
        await waitFor(() => calls === 2, "a second read");
      } finally {
        unmount();
      }
    });

    it("says when the diff is too large, and when it has nothing in the lines", async () => {
      for (const [answer, message] of [
        [{ patch: "", tooLarge: true }, "The diff is too large to show here."],
        [{ patch: "@@ -1,1 +1,1 @@\n-a\n+b", tooLarge: false }, "No changes in these lines."],
      ] as const) {
        stubReviewApi({
          reviewFileDiff: async (_ws, _pr, path) => ({
            path,
            ...answer,
            headSha: "h",
            mergeBaseSha: "b",
          }),
        });
        const { host, unmount } = await mountForInteraction(
          createElement(VerificationReportView, {
            report: mustRead,
            onOpen: { open: () => {}, canOpen: () => true },
            diffSource: source(),
          }),
        );
        try {
          const details = snippetOf(host);
          toggle(details, true);
          await waitFor(() => !!details.textContent?.includes(message), message);
        } finally {
          unmount();
        }
      }
    });

    it("shows at most 80 lines and points to the file for the rest", async () => {
      const long = ["@@ -1,0 +1,100 @@", ...Array.from({ length: 100 }, (_, i) => `+line ${i}`)];
      stubReviewApi({
        reviewFileDiff: async (_ws, _pr, path) => ({
          path,
          patch: long.join("\n"),
          tooLarge: false,
          headSha: "h",
          mergeBaseSha: "b",
        }),
      });
      const { host, unmount } = await mountForInteraction(
        createElement(VerificationReportView, {
          report: { ...mustRead, mustRead: [{ ...mustRead.mustRead[0], lines: undefined }] },
          onOpen: { open: () => {}, canOpen: () => true },
          diffSource: source(),
        }),
      );
      try {
        const details = snippetOf(host);
        toggle(details, true);
        // The hunk header and 100 lines: 80 shown, 21 left.
        await waitFor(
          () => !!details.textContent?.includes("21 more lines: open the file to read them."),
          "the overflow note",
        );
      } finally {
        unmount();
      }
    });

    it("offers no snippet for must-reads from an older head", async () => {
      const text = textOf(
        await renderToHtml(
          createElement(VerificationReportView, {
            report: mustRead,
            onOpen: { open: () => {}, canOpen: () => true },
            diffSource: source(),
            currentSections: new Set(["risk"]),
          }),
        ),
      );
      expect(text).toContain("Does a write evict the cached profile?");
      expect(text).not.toContain("Show the diff");
    });
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
            {
              ...change,
              title: "Sort the staff view",
              reach: "local",
              internal: true,
              check: "",
              band: 2,
            },
            {
              ...change,
              title: "Gate the staff view",
              reach: "local",
              sensitive: true,
              internal: true,
              check: "",
              band: 3,
            },
          ],
        },
      },
    };
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report: scored,
        onOpen: { open: () => {}, canOpen: () => true },
      }),
    );
    const text = textOf(html);
    expect(text).toContain("Impact 4/5 · high");
    // The agent's level matches the band's, so it isn't shown twice.
    expect(text).not.toContain("high risk");
    expect(text).toContain("4 passive, 2 logic changes");
    expect(text).toContain("raised from moderate by the number of changes");
    expect(text).toContain("Confirm: A write evicts the cached profile");
    expect(text).toContain("Every scored change (4)");
    const host = document.createElement("div");
    host.innerHTML = html;
    // Every trait is a labelled chip that explains itself on hover.
    const traits = (title: string) => {
      const li = [...host.querySelectorAll("li")].find((l) => l.textContent?.startsWith(title));
      return [...(li?.querySelectorAll("span[title]") ?? [])].map((s) => s.textContent);
    };
    expect(traits("Sort the staff view")).toEqual([
      "2/5",
      "logic",
      "reach: local",
      "partly tested",
      "internal only",
    ]);
    expect(traits("Gate the staff view")).toEqual([
      "3/5",
      "logic",
      "reach: local",
      "partly tested",
      "sensitive",
    ]);
    expect(traits("Tidy comments")).toEqual([
      "1/5",
      "passive",
      "reach: core",
      "partly tested",
      "×4",
    ]);
    expect(host.querySelector('span[title^="Reach: used from five"]')?.textContent).toBe(
      "reach: core",
    );
  });

  it("shows the score before and after the PR's tests, a concern's fix, and each mitigation under its risk", async () => {
    const risk = report.risk as NonNullable<VerificationReport["risk"]>;
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            risk: {
              ...risk,
              level: "medium",
              mitigations: [
                {
                  text: "Short TTL",
                  addresses: "No invalidation on write",
                  path: "src/cache.ts",
                  line: 3,
                },
                { text: "Behind the cache flag", addresses: "Something else" },
              ],
              concerns: [
                {
                  title: "No invalidation on write",
                  detail: "Edits stay stale.",
                  severity: "high",
                  fix: "Evict the profile in the write path.",
                },
              ],
              impact: {
                band: 3,
                potentialBand: 4,
                highestChangeBand: 3,
                load: 2,
                raisedByVolume: 0,
                counts: {
                  passive: 0,
                  reorganization: 0,
                  addition: 0,
                  removal: 0,
                  interface: 0,
                  logic: 1,
                },
                changes: [],
              },
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Potential 4/5→With its tests 3/5 · moderate");
    expect(text).toContain("Suggested fix: Evict the profile in the write path.");
    expect(text).toContain(
      "Edits stay stale.Suggested fix: Evict the profile in the write path.Limited by:Short TTLsrc/cache.ts:3",
    );
    expect(text).toContain(
      "Other mitigations in the PR:Behind the cache flag (limits: Something else)",
    );
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
    expect(text).toContain("Impact 2/5 · low");
    expect(text).toContain("high risk");
    expect(text).not.toContain("Changes that need your attention");
    expect(text).toContain("Every scored change (1)");
  });

  it("shows only the band when the agent's level matches it", async () => {
    const risk = report.risk as NonNullable<VerificationReport["risk"]>;
    const counts = {
      passive: 0,
      reorganization: 0,
      addition: 0,
      removal: 0,
      interface: 0,
      logic: 1,
    };
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            risk: {
              ...risk,
              level: "medium",
              impact: {
                band: 3,
                highestChangeBand: 3,
                load: 2,
                raisedByVolume: 0,
                counts,
                changes: [],
              },
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Impact 3/5 · moderate");
    expect(text).not.toContain("medium risk");
    expect(text).not.toContain("raised from");
  });

  it("gives each theme its change, risk and proof, and lists outliers under unrelated changes", async () => {
    const theme = {
      cohesion: "core" as const,
      question: "",
      files: [{ path: "src/cache.ts" }],
    };
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            changeMap: {
              intent: "Cache user lookups.",
              unmapped: [],
              themes: [
                {
                  ...theme,
                  title: "Serve lookups from the cache",
                  description: "Reads hit the cache first.",
                  risk: "high",
                  riskWhy: "A stale entry shows a user someone else's profile.",
                  proofs: [{ text: "Keys by user id", path: "src/cache.test.ts", line: 4 }],
                  unmitigated: "Add a test that a write evicts the entry.",
                },
                {
                  ...theme,
                  title: "Log cache misses",
                  description: "Counts misses.",
                  risk: "low",
                  riskWhy: "A wrong count misleads tuning.",
                  proofs: [],
                  unmitigated: "",
                },
                {
                  ...theme,
                  title: "Document the cache",
                  description: "Adds a README section.",
                  risk: "none",
                  riskWhy: "",
                  proofs: [],
                  unmitigated: "",
                },
                {
                  ...theme,
                  title: "Older theme",
                  description: "From a report before proofs.",
                  risk: "medium",
                },
                {
                  ...theme,
                  title: "Bump the linter",
                  description: "Upgrades biome.",
                  risk: "low",
                  cohesion: "outlier",
                  question: "Why bump the linter here?",
                },
              ],
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain(
      "Change: Reads hit the cache first.Risk: A stale entry shows a user someone else's profile.Proof it's handled:Keys by user idsrc/cache.test.ts:4Not covered: Add a test that a write evicts the entry.",
    );
    expect(text).toContain("A wrong count misleads tuning.Proof it's handled: None found");
    expect(text).toContain("no riskDocument the cacheChange: Adds a README section.src/cache.ts");
    // A report from before proofs says nothing either way.
    expect(text).toContain("Change: From a report before proofs.src/cache.ts");
    expect(text).toContain("Anything malicious or unrelated?");
    expect(text).toContain("Unrelated changes");
    expect(text).toContain("Bump the linter · Why bump the linter here?");
  });

  it("posts what to add: a theme's uncovered risk, a concern's fix, and an attention change's proof to add", async () => {
    const posted: { title: string; detail: string; section: string }[] = [];
    const risk = report.risk as NonNullable<VerificationReport["risk"]>;
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: {
          ...report,
          changeMap: {
            intent: "Cache user lookups.",
            unmapped: [],
            themes: [
              {
                title: "Serve lookups from the cache",
                description: "d",
                risk: "high",
                riskWhy: "A stale entry shows an old profile.",
                proofs: [],
                unmitigated: "Add a test that a write evicts the entry.",
                cohesion: "core",
                question: "",
                files: [{ path: "src/cache.ts" }],
              },
              {
                title: "Document the cache",
                description: "d",
                risk: "none",
                riskWhy: "",
                proofs: [],
                unmitigated: "",
                cohesion: "supporting",
                question: "",
                files: [{ path: "README.md" }],
              },
            ],
          },
          risk: {
            ...risk,
            level: "high",
            mitigations: [
              // Matched to its concern whatever its case and spacing.
              { text: "Short TTL", addresses: " no invalidation ON write " },
            ],
            concerns: [
              {
                title: "No invalidation on write",
                detail: "Edits stay stale.",
                severity: "medium",
                fix: "Evict on write.",
                path: "src/cache.ts",
                line: 22,
              },
            ],
            impact: {
              band: 4,
              potentialBand: 4,
              highestChangeBand: 4,
              load: 4,
              raisedByVolume: 0,
              counts: {
                passive: 0,
                reorganization: 0,
                addition: 0,
                removal: 0,
                interface: 0,
                logic: 2,
              },
              changes: [
                {
                  title: "Read through the cache",
                  kind: "logic",
                  reach: "shared",
                  evidence: "unproven",
                  sensitive: false,
                  count: 1,
                  check: "A write evicts the entry.",
                  fix: "Add a test that writes then reads.",
                  path: "src/cache.ts",
                  line: 30,
                  band: 4,
                },
                {
                  title: "Retry the lookup",
                  kind: "logic",
                  reach: "shared",
                  evidence: "partial",
                  sensitive: false,
                  count: 1,
                  check: "Retries stop.",
                  path: "src/lookup.ts",
                  line: 3,
                  band: 4,
                },
              ],
            },
          },
        },
        onOpen: { open: () => {}, canOpen: () => true },
        actions: {
          poster: {
            toPr: async (f, section) => {
              posted.push({ title: f.title, detail: f.detail, section });
              return undefined;
            },
          },
        },
      }),
    );
    try {
      const text = textOf(host.innerHTML);
      // The same score before and after the tests shows once, with no "Potential".
      expect(text).toContain("Impact 4/5");
      expect(text).not.toContain("Potential");
      expect(text).toContain("Limited by:Short TTL");
      const buttons = [...host.querySelectorAll("button")].filter(
        (b) => b.textContent === "Post to PR",
      );
      // The theme with something uncovered, the concern, and the change with a fix:
      // not the no-risk theme, nor the change with nothing to add.
      expect(buttons).toHaveLength(3);
      for (const b of buttons) b.click();
      await waitFor(() => posted.length === 3, "the posts");
      expect(posted).toEqual(
        expect.arrayContaining([
          {
            title: "Serve lookups from the cache",
            detail:
              "A stale entry shows an old profile.\nNot covered: Add a test that a write evicts the entry.",
            section: "Change map",
          },
          {
            title: "No invalidation on write",
            detail: "Edits stay stale.\nSuggested fix: Evict on write.",
            section: "Risk",
          },
          {
            title: "Read through the cache",
            detail: "A write evicts the entry.\nTo prove it: Add a test that writes then reads.",
            section: "Impact",
          },
        ]),
      );
    } finally {
      unmount();
    }
  });

  it("shows no severity on a concern from before concerns had one", async () => {
    const html = await renderToHtml(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
      }),
    );
    const host = document.createElement("div");
    host.innerHTML = html;
    const li = [...host.querySelectorAll("li")].find((l) =>
      l.textContent?.startsWith("No invalidation on write"),
    );
    expect(li).toBeDefined();
    expect(li?.textContent).not.toMatch(/^(high|medium|low)/);
  });

  it("lists every scored change under the change map theme its file is in", async () => {
    const change = {
      kind: "logic" as const,
      reach: "local" as const,
      evidence: "partial" as const,
      sensitive: false,
      count: 1,
      check: "",
      band: 3 as const,
    };
    const risk = report.risk as NonNullable<VerificationReport["risk"]>;
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: {
            ...report,
            changeMap: {
              intent: "Cache user lookups.",
              unmapped: [],
              themes: [
                {
                  title: "Serve lookups from the cache",
                  description: "d",
                  risk: "medium",
                  cohesion: "core",
                  question: "",
                  files: [{ path: "src/cache.ts" }, { path: "src/store/db.ts" }],
                },
              ],
            },
            risk: {
              ...risk,
              impact: {
                band: 3,
                highestChangeBand: 3,
                load: 4,
                raisedByVolume: 0,
                counts: {
                  passive: 0,
                  reorganization: 0,
                  addition: 0,
                  removal: 0,
                  interface: 0,
                  logic: 2,
                },
                changes: [
                  { ...change, title: "Read through the cache", path: "src/cache.ts" },
                  { ...change, title: "Retry the lookup", path: "src/lookup.ts" },
                  // A folded change on a folder joins the theme of a file in it.
                  { ...change, title: "Tidy the store", path: "src/store" },
                  // A path that only shares a prefix with a theme file is not in it.
                  { ...change, title: "Rename the cache helper", path: "src/cach" },
                ],
              },
            },
          },
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Grouped by the change map's themes.");
    expect(text).toContain("Serve lookups from the cacheRead through the cachesrc/cache.ts");
    expect(text).toContain("Read through the cachesrc/cache.ts");
    expect(text).toContain("Tidy the storesrc/store");
    const inTheme = text.slice(
      text.indexOf("Serve lookups from the cacheRead"),
      text.indexOf("In no theme"),
    );
    expect(inTheme).toContain("Tidy the store");
    expect(inTheme).not.toContain("Rename the cache helper");
    expect(text.slice(text.indexOf("In no theme"))).toContain("Rename the cache helper");
    expect(text.slice(text.indexOf("In no theme"))).toContain("Retry the lookup");
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
    expect(text).toContain("Complexitypasses");
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

  it("lists the malicious-intent check's tripwires even when it passes, each opening its line", async () => {
    const opened: unknown[] = [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: {
          ...report,
          malice: {
            ...pass,
            tripwires: [
              { kind: "build", path: ".github/workflows/ci.yml", note: "CI configuration" },
              { kind: "hidden-text", path: "src/auth.ts", line: 7, note: "invisible characters" },
            ],
            tripwiresOmitted: 3,
          },
        },
        onOpen: { open: (path, line) => opened.push([path, line]), canOpen: () => true },
      }),
    );
    try {
      const text = textOf(host.innerHTML);
      expect(text).toContain("Malicious intentpasses");
      expect(text).toContain("5 tripwires to confirm");
      expect(text).toContain("Hidden text");
      expect(text).toContain("3 more not listed.");
      const link = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "src/auth.ts:7",
      );
      link?.click();
      await waitFor(() => opened.length > 0, "the open");
      expect(opened).toEqual([["src/auth.ts", 7]]);
    } finally {
      unmount();
    }
  });

  it("says when a PR stacked above changes a finding's line, but not for an older head's", async () => {
    const upstack = {
      headSha: "h",
      note: null,
      layers: [
        {
          number: 8,
          url: "https://github.com/o/r/pull/8",
          stale: false,
          files: [{ path: "src/cache.test.ts", ranges: null }],
        },
      ],
    };
    const render = async (currentSections?: Set<string>) =>
      textOf(
        await renderToHtml(
          createElement(VerificationReportView, {
            report,
            upstack,
            currentSections,
            onOpen: { open: () => {}, canOpen: () => true },
          }),
        ),
      );
    expect(await render()).toContain("changed in #8 above");
    expect(await render(new Set(["summary"]))).not.toContain("changed in #8 above");
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
        actions: {
          poster: {
            toPr: async (f, section) => {
              sent.push(`pr ${section} ${f.path}:${f.line}`);
              return undefined;
            },
            toWorkspace: {
              name: "cache-work",
              add: async () => {
                throw new Error("workspace repo not found");
              },
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

  it("holds the button while the post is in flight", async () => {
    let release = () => {};
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions: {
          poster: {
            toPr: () =>
              new Promise<undefined>((resolve) => {
                release = () => resolve(undefined);
              }),
          },
        },
      }),
    );
    try {
      const find = (label: string) =>
        [...host.querySelectorAll("button")].find((b) => b.textContent === label);
      find("Post to PR")?.click();
      await waitFor(() => find("Posting…") != null, "the posting state");
      expect(find("Posting…")?.disabled).toBe(true);
      release();
      await waitFor(() => find("Posted to PR") != null, "the posted state");
    } finally {
      unmount();
    }
  });

  it("says when GitHub put a finding on the whole file", async () => {
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report,
        onOpen: { open: () => {}, canOpen: () => true },
        actions: { poster: { toPr: async () => "file" as const } },
      }),
    );
    try {
      const post = [...host.querySelectorAll("button")].find((b) => b.textContent === "Post to PR");
      post?.click();
      await waitFor(
        () => textOf(host.innerHTML).includes("Posted on the whole file instead"),
        "the notice",
      );
      const posted = [...host.querySelectorAll("button")].find(
        (b) => b.textContent === "Posted to PR",
      );
      expect(posted?.disabled).toBe(true);
    } finally {
      unmount();
    }
  });

  it("shows only the sections a run was asked for, and leaves the flow to its own tab", async () => {
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
    expect(text).not.toContain("How a lookup is cached");
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

describe("the change map and claims", () => {
  const withMap: VerificationReport = {
    mustRead: [],
    changeMap: {
      intent: "Caches user lookups.",
      themes: [
        {
          title: "Cache the lookup",
          description: "Reads go through an LRU.",
          risk: "medium",
          cohesion: "core",
          question: "",
          files: [{ path: "src/cache.ts", lines: { start: 3, end: 40 } }],
        },
        {
          title: "Bump the timeout",
          description: "The HTTP timeout goes from 5s to 30s.",
          risk: "low",
          cohesion: "outlier",
          question: "Why does this PR change the HTTP timeout?",
          files: [{ path: "src/http.ts" }],
        },
      ],
      unmapped: ["README.md"],
    },
    claims: {
      items: [
        {
          claim: "Caches user lookups",
          source: "description",
          status: "verified",
          evidence: "getUser reads through the cache",
          path: "src/cache.ts",
          line: 12,
        },
        {
          claim: "Invalidates on write",
          source: "ABC-12",
          status: "missing",
          evidence: "No write path clears the cache",
          path: "src/users.ts",
          line: 30,
        },
      ],
      gaps: [
        {
          title: "TODO left in eviction",
          detail: "d",
          severity: "medium",
          path: "src/cache.ts",
          line: 50,
        },
      ],
      tickets: [
        { key: "ABC-12", title: "Cache users", url: "https://acme.atlassian.net/browse/ABC-12" },
      ],
      ticketNotes: ["Couldn't read XY-1: not found"],
    },
  };

  it("lists each theme with how it fits, and the files no theme names", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: withMap,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Caches user lookups.");
    expect(text).toContain("Coremedium riskCache the lookup");
    expect(text).toContain("src/cache.ts:3-40");
    expect(text).toContain("Outlierlow riskBump the timeout");
    expect(text).toContain("Ask the author: Why does this PR change the HTTP timeout?");
    expect(text).toContain("In no theme:README.md");
  });

  it("sends an outlier's question and an unmet claim to the PR, but not a verified claim", async () => {
    const posted: { title: string; detail: string; path: string; line: number; section: string }[] =
      [];
    const { host, unmount } = await mountForInteraction(
      createElement(VerificationReportView, {
        report: withMap,
        onOpen: { open: () => {}, canOpen: () => true },
        actions: {
          poster: {
            toPr: async (f, section) => {
              posted.push({ ...f, section });
              return undefined;
            },
          },
        },
      }),
    );
    const buttons = [...host.querySelectorAll("button")].filter(
      (b) => b.textContent === "Post to PR",
    );
    // The outlier, the missing claim and the unfinished work: never the verified claim.
    expect(buttons).toHaveLength(3);
    for (const b of buttons) b.click();
    await waitFor(() => posted.length === 3, "the posts");
    expect(posted).toContainEqual({
      title: "Bump the timeout",
      detail: "Why does this PR change the HTTP timeout?",
      path: "src/http.ts",
      line: 1,
      section: "Change map",
    });
    expect(posted).toContainEqual(
      expect.objectContaining({ title: "Invalidates on write", section: "Claims: missing" }),
    );
    unmount();
  });

  it("shows each claim's verdict, what it was checked against, and the unfinished work", async () => {
    const text = textOf(
      await renderToHtml(
        createElement(VerificationReportView, {
          report: withMap,
          onOpen: { open: () => {}, canOpen: () => true },
        }),
      ),
    );
    expect(text).toContain("Checked against the title, description andABC-12");
    expect(text).toContain("Couldn't read XY-1: not found");
    expect(text).toContain("VerifiedCaches user lookupsdescription");
    expect(text).toContain("MissingInvalidates on writeABC-12");
    expect(text).toContain("Unfinished work1 finding");
  });
});
