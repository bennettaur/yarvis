import { describe, expect, it } from "bun:test";
import type { Facts } from "./collect.ts";
import {
  coverageStatus,
  finalVerdict,
  inline,
  parseSignedReport,
  REPORT_MARKER,
  Review,
  renderReport,
  withSignature,
} from "./report.ts";

const TARGET = { repo: "bennettaur/yarvis", pr: 7 };

const pass = { status: "pass" as const, note: "fine" };

type Change = Review["changes"][number];

function change(overrides: Partial<Change> = {}): Change {
  return {
    title: "Add a drag handle to the divider",
    location: "src/components/List.tsx:40",
    kind: "addition",
    reach: "leaf",
    evidence: "proven",
    sensitive: false,
    count: 1,
    check: "",
    ...overrides,
  };
}

function makeReview(overrides: Partial<Review> = {}): Review {
  return {
    goal: "Let the workspace list be resized",
    summary: "Adds a drag handle to the workspace list divider.",
    verdict: "auto",
    verdictReason: "Small, tested, UI only.",
    risk: { tier: "low", reasons: ["Layout only; calls nothing new"] },
    changes: [change()],
    assessed: [],
    dimensions: {
      goal: pass,
      tests: pass,
      reliability: pass,
      security: pass,
      complexity: pass,
      maintainability: pass,
      ui: { status: "n/a", note: "Nothing renders differently" },
      supplyChain: { status: "n/a", note: "No dependency changed" },
    },
    findings: [],
    screenshots: [],
    reviewers: ["security-privacy-reviewer"],
    model: "claude-opus-5-5",
    ...overrides,
  };
}

function makeFacts(overrides: Partial<Facts> = {}): Facts {
  return {
    base: "a".repeat(40),
    head: "b".repeat(40),
    files: [{ path: "src/components/List.tsx", additions: 40, deletions: 2 }],
    tier: { tier: "low", reasons: [], assess: [] },
    coverage: {
      changedLines: 20,
      coveredLines: 18,
      ratio: 0.9,
      uncovered: [],
      notLoaded: [],
      unmeasured: [],
      noTestsRan: [],
    },
    baseline: { detecting: 3, notDetecting: [], failingOnHead: [] },
    suites: ["frontend"],
    ...overrides,
  };
}

describe("finalVerdict", () => {
  it("keeps an auto verdict for a clean low-risk PR", () => {
    expect(finalVerdict(makeReview(), makeFacts()).verdict).toBe("auto");
  });

  it("needs a human for high risk and lets a clean standard-risk PR merge", () => {
    const facts = makeFacts({ tier: { tier: "high", reasons: ["CI or repo config"], assess: [] } });
    expect(finalVerdict(makeReview(), facts)).toEqual({
      verdict: "human",
      why: ["high-risk change"],
    });
    expect(
      finalVerdict(makeReview(), makeFacts({ tier: { tier: "standard", reasons: [], assess: [] } }))
        .verdict,
    ).toBe("auto");
  });

  describe("files the path floor sent for assessment", () => {
    const facts = makeFacts({
      tier: {
        tier: "standard",
        reasons: [],
        assess: [
          { path: "package.json", reason: "a dependency file change beyond registry versions" },
        ],
      },
    });
    const rated = (tier: "standard" | "high") =>
      makeReview({ assessed: [{ path: "package.json", tier, reason: "Adds a lint script" }] });

    it("need a human when one wasn't assessed", () => {
      expect(finalVerdict(makeReview(), facts).verdict).toBe("human");
    });

    it("follow the assessment", () => {
      expect(finalVerdict(rated("standard"), facts).verdict).toBe("auto");
      expect(finalVerdict(rated("high"), facts).verdict).toBe("human");
    });

    it("are listed with their rating and signed as assessed", () => {
      const { body, data } = renderReport(rated("standard"), facts, TARGET);
      expect(body).toContain("`package.json`: standard. Adds a lint script");
      expect(data.assessed).toEqual(["package.json"]);
      expect(renderReport(makeReview(), facts, TARGET).body).toContain(
        "`package.json`: not assessed, so high.",
      );
    });
  });

  it("needs an agent for a major finding and a human for a blocker", () => {
    const finding = (severity: "major" | "blocker") =>
      makeReview({ findings: [{ severity, title: "Leaks a listener", detail: "…" }] });
    expect(finalVerdict(finding("major"), makeFacts()).verdict).toBe("agent");
    expect(finalVerdict(finding("blocker"), makeFacts()).verdict).toBe("human");
  });

  it("lets a PR with only minor findings merge", () => {
    const review = makeReview({
      findings: [{ severity: "minor", title: "Stale comment", detail: "…" }],
    });
    expect(finalVerdict(review, makeFacts())).toEqual({ verdict: "auto", why: [] });
  });

  it("lets a small UI change the screenshots show merge on its own", () => {
    const review = makeReview({
      dimensions: { ...makeReview().dimensions, ui: pass },
      screenshots: [{ path: "/tmp/verify/7/after.png", caption: "Resized list" }],
    });
    expect(finalVerdict(review, makeFacts())).toEqual({ verdict: "auto", why: [] });
    expect(renderReport(review, makeFacts(), TARGET).data.needsVisual).toBe(false);
  });

  it("keeps a visual verdict the review gives, and signs that a person looks", () => {
    const review = makeReview({
      verdict: "visual",
      dimensions: { ...makeReview().dimensions, ui: pass },
      screenshots: [{ path: "/tmp/verify/7/after.png", caption: "New settings page" }],
    });
    expect(finalVerdict(review, makeFacts()).verdict).toBe("visual");
    expect(renderReport(review, makeFacts(), TARGET).data.needsVisual).toBe(true);
  });

  it("lets a concern or a blocker outrank a visual check", () => {
    const shots = [{ path: "/tmp/verify/7/after.png", caption: "Resized list" }];
    const concern = makeReview({
      dimensions: { ...makeReview().dimensions, ui: { status: "concern", note: "Clipped" } },
      screenshots: shots,
    });
    expect(finalVerdict(concern, makeFacts()).verdict).toBe("agent");
    const blocked = makeReview({
      dimensions: { ...makeReview().dimensions, ui: pass },
      screenshots: shots,
      findings: [{ severity: "blocker", title: "Loses data", detail: "…" }],
    });
    expect(finalVerdict(blocked, makeFacts()).verdict).toBe("human");
  });

  it("signs that a person has to look when the UI check is flagged", () => {
    expect(renderReport(makeReview(), makeFacts(), TARGET).data.needsVisual).toBe(false);
    const concern = makeReview({
      dimensions: { ...makeReview().dimensions, ui: { status: "concern", note: "Not captured" } },
    });
    expect(renderReport(concern, makeFacts(), TARGET).data.needsVisual).toBe(true);
  });

  it("needs an agent for a UI change with no screenshots to look at", () => {
    const review = makeReview({ dimensions: { ...makeReview().dimensions, ui: pass } });
    expect(finalVerdict(review, makeFacts()).verdict).toBe("agent");
  });

  it("needs an agent when dependencies changed and nobody checked the supply chain", () => {
    const facts = makeFacts({ files: [{ path: "bun.lock", additions: 4, deletions: 4 }] });
    expect(finalVerdict(makeReview(), facts)).toEqual({
      verdict: "agent",
      why: ["dependencies changed without a supply-chain check"],
    });
    const checked = makeReview({
      dimensions: {
        ...makeReview().dimensions,
        supplyChain: { status: "pass", note: "zod 4.6.6 to 4.6.7: patch, no advisories" },
      },
    });
    expect(finalVerdict(checked, facts).verdict).toBe("auto");
  });

  it("needs an agent for a concern and a human for a failed check", () => {
    const withSecurity = (status: "concern" | "fail") =>
      makeReview({ dimensions: { ...makeReview().dimensions, security: { status, note: "XSS" } } });
    expect(finalVerdict(withSecurity("concern"), makeFacts()).verdict).toBe("agent");
    expect(finalVerdict(withSecurity("fail"), makeFacts()).verdict).toBe("human");
  });

  it("follows diff coverage", () => {
    const at = (ratio: number) => makeFacts({ coverage: { ...makeFacts().coverage, ratio } });
    expect(finalVerdict(makeReview(), at(0.6)).verdict).toBe("agent");
    expect(finalVerdict(makeReview(), at(0.2)).verdict).toBe("human");
  });

  const mutation = (killed: number, survivedCount: number) => ({
    score: killed / (killed + survivedCount),
    killed,
    survived: Array.from({ length: survivedCount }, (_, i) => `src/a.ts:${i + 1} BlockStatement`),
    skippedRanges: 0,
  });

  it("needs an agent when the tests miss many mutations on the changed lines", () => {
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(5, 5) })).verdict).toBe(
      "agent",
    );
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(6, 4) })).verdict).toBe(
      "auto",
    );
  });

  it("doesn't judge the tests on too few mutants", () => {
    expect(finalVerdict(makeReview(), makeFacts({ mutation: mutation(1, 3) })).verdict).toBe(
      "auto",
    );
  });

  it("needs a human when tests fail on the PR", () => {
    const facts = makeFacts({
      baseline: { detecting: 0, notDetecting: [], failingOnHead: ["a.test.ts > x"] },
    });
    expect(finalVerdict(makeReview(), facts).verdict).toBe("human");
  });

  it("only ever tightens when several limits apply", () => {
    const review = makeReview({ findings: [{ severity: "blocker", title: "x", detail: "…" }] });
    const facts = makeFacts({ tier: { tier: "standard", reasons: [], assess: [] } });
    expect(finalVerdict(review, facts).verdict).toBe("human");
  });

  it("takes the assessed risk when it is stricter than the paths'", () => {
    const review = makeReview({ risk: { tier: "high", reasons: ["Writes a secret from the UI"] } });
    expect(finalVerdict(review, makeFacts()).verdict).toBe("human");
    expect(renderReport(review, makeFacts(), TARGET).data.riskTier).toBe("high");
  });

  it("never lets an assessed low risk lower the paths' tier", () => {
    const facts = makeFacts({
      tier: { tier: "high", reasons: ["dependencies (bun.lock)"], assess: [] },
    });
    expect(renderReport(makeReview(), facts, TARGET).data.riskTier).toBe("high");
  });

  it("can be made stricter by the reviewer", () => {
    expect(finalVerdict(makeReview({ verdict: "human" }), makeFacts()).verdict).toBe("human");
  });

  describe("impact", () => {
    const coreLogic = change({
      title: "Retry failed sends",
      location: "sidecar/src/chat/agent.ts:120",
      kind: "logic",
      reach: "core",
      evidence: "partial",
      check: "A retry can't send the message twice",
    });
    // No changed files, so the review's changes are all there is to score.
    const noChangedFiles = makeFacts({ files: [] });

    it("needs an agent for a high-impact change", () => {
      expect(finalVerdict(makeReview({ changes: [coreLogic] }), noChangedFiles)).toEqual({
        verdict: "agent",
        why: ["high-impact changes"],
      });
    });

    it("needs a human for a very high one", () => {
      const review = makeReview({ changes: [coreLogic, { ...coreLogic, kind: "interface" }] });
      expect(finalVerdict(review, noChangedFiles)).toEqual({
        verdict: "human",
        why: ["very high impact"],
      });
    });

    it("needs only an agent when volume alone makes it high", () => {
      const review = makeReview({
        changes: [change({ kind: "logic", reach: "local", evidence: "partial", count: 20 })],
      });
      expect(finalVerdict(review, noChangedFiles)).toEqual({
        verdict: "agent",
        why: ["high-impact changes"],
      });
    });

    it("lets a moderate-impact PR merge on its own", () => {
      const review = makeReview({
        changes: [change({ kind: "logic", reach: "local", evidence: "partial" })],
      });
      expect(finalVerdict(review, noChangedFiles).verdict).toBe("auto");
    });

    describe("the facts' floor under a review's classification", () => {
      const facts = makeFacts({
        files: [
          { path: "src/a.ts", additions: 9, deletions: 0 },
          { path: "src/b.ts", additions: 4, deletions: 0 },
        ],
        reach: [
          { path: "src/a.ts", importers: 30, otherAreas: 9, suggested: "core" },
          { path: "src/b.ts", importers: 2, otherAreas: 2, suggested: "shared" },
        ],
      });

      it("scores a logic change at no less than its file's measured reach", () => {
        const review = makeReview({
          changes: [
            change({ kind: "logic", reach: "leaf", evidence: "partial", location: "src/a.ts:3" }),
            change({ kind: "passive", location: "src/b.ts" }),
          ],
        });
        const { body } = renderReport(review, facts, TARGET);
        expect(finalVerdict(review, facts).verdict).toBe("agent");
        expect(body).toContain("logic, core; its file has 30 importers");
      });

      it("leaves the claimed reach of an addition alone", () => {
        const review = makeReview({
          changes: [
            change({ kind: "addition", reach: "leaf", location: "src/a.ts:3" }),
            change({ kind: "passive", location: "src/b.ts" }),
          ],
        });
        expect(finalVerdict(review, facts).verdict).toBe("auto");
      });

      it("scores a changed code file no change names as an unlisted logic change", () => {
        const review = makeReview({
          changes: [change({ kind: "passive", location: "src/a.ts" })],
        });
        const { body } = renderReport(review, facts, TARGET);
        expect(finalVerdict(review, facts)).toEqual({
          verdict: "agent",
          why: ["high-impact changes"],
        });
        expect(body).toContain(
          "- **Change the review didn't list** `src/b.ts`: logic, shared; its file has 2 importers in 2 other areas, partly tested. Check: Nobody classified this file's change: read it.",
        );
      });

      it("doesn't let a passive entry at a folder vouch for the files under it", () => {
        const review = makeReview({
          changes: [
            change({ kind: "passive", location: "src/a.ts" }),
            change({ kind: "passive", location: "src/" }),
          ],
        });
        expect(renderReport(review, facts, TARGET).body).toContain(
          "**Change the review didn't list** `src/b.ts`",
        );
      });

      it("lets a logic entry at a folder name the files under it", () => {
        const review = makeReview({
          changes: [
            change({ kind: "logic", reach: "core", evidence: "partial", location: "src/" }),
          ],
        });
        expect(renderReport(review, facts, TARGET).body).not.toContain(
          "Change the review didn't list",
        );
      });

      it("scores an unlisted file the graph has no reach for as shared", () => {
        const rust = makeFacts({
          files: [{ path: "src-tauri/src/a.rs", additions: 5, deletions: 0 }],
        });
        const review = makeReview({ changes: [change({ kind: "passive", location: "docs/" })] });
        expect(finalVerdict(review, rust).verdict).toBe("agent");
      });

      it("counts a file the diff only deletes from, since deleting a guard changes behaviour", () => {
        const deleted = makeFacts({
          files: [{ path: "src/gone.ts", additions: 0, deletions: 30 }],
        });
        const unnamed = makeReview({ changes: [change({ kind: "passive", location: "docs/" })] });
        expect(finalVerdict(unnamed, deleted).verdict).toBe("agent");
        const named = makeReview({
          changes: [change({ kind: "removal", evidence: "partial", location: "src/gone.ts" })],
        });
        expect(finalVerdict(named, deleted).verdict).toBe("auto");
      });

      it("scores an unproven reorganization or a removal at no less than its file's reach", () => {
        // An untested removal from core code is high; at leaf it would be low.
        for (const [kind, evidence] of [
          ["reorganization", "partial"],
          ["removal", "unproven"],
        ] as const) {
          const review = makeReview({
            changes: [
              change({ kind, reach: "leaf", evidence, location: "src/a.ts" }),
              change({ kind: "passive", location: "src/b.ts" }),
            ],
          });
          expect(finalVerdict(review, facts).verdict).toBe("agent");
        }
      });

      it("treats a reorganization coverage doesn't back as unproven for its reach", () => {
        const uncovered = makeFacts({
          ...facts,
          coverage: { ...facts.coverage, uncovered: [{ path: "src/a.ts", lines: "3" }] },
        });
        const review = makeReview({
          changes: [
            change({
              kind: "reorganization",
              reach: "leaf",
              evidence: "proven",
              location: "src/a.ts",
            }),
            change({ kind: "passive", location: "src/b.ts" }),
          ],
        });
        expect(finalVerdict(review, uncovered).verdict).toBe("agent");
      });

      it("keeps a claimed reach above the measured one", () => {
        const review = makeReview({
          changes: [
            change({ kind: "logic", reach: "core", evidence: "partial", location: "src/b.ts" }),
            change({ kind: "passive", location: "src/a.ts" }),
          ],
        });
        expect(finalVerdict(review, facts).verdict).toBe("agent");
      });
    });

    describe("a proven claim", () => {
      const sharedLogic = (overrides: Partial<Change> = {}) =>
        makeReview({
          changes: [
            change({ kind: "logic", reach: "shared", location: "src/a.ts:3", ...overrides }),
            change({ kind: "passive", location: "src/b.ts" }),
          ],
        });
      const covered = makeFacts({
        files: [
          { path: "src/a.ts", additions: 9, deletions: 0 },
          { path: "src/b.ts", additions: 4, deletions: 0 },
        ],
      });
      const withCoverage = (coverage: Partial<Facts["coverage"]>) =>
        makeFacts({ ...covered, coverage: { ...covered.coverage, ...coverage } });

      it("stands where tests ran every changed line", () => {
        expect(finalVerdict(sharedLogic(), covered).verdict).toBe("auto");
      });

      it("counts as partial where changed lines have no test, with a prompt to read it", () => {
        const facts = withCoverage({ uncovered: [{ path: "src/a.ts", lines: "3-9" }] });
        expect(finalVerdict(sharedLogic(), facts)).toEqual({
          verdict: "agent",
          why: ["high-impact changes"],
        });
        expect(renderReport(sharedLogic(), facts, TARGET).body).toContain(
          "Check: none given, so read this change",
        );
      });

      it("counts as partial in a file no test loads, or a PR measured without running it", () => {
        for (const coverage of [{ notLoaded: ["src/a.ts"] }, { unmeasured: ["src/a.ts"] }]) {
          expect(finalVerdict(sharedLogic(), withCoverage(coverage)).verdict).toBe("agent");
        }
      });

      it("counts as partial where its location names no changed file", () => {
        const review = makeReview({
          changes: [
            change({ kind: "logic", reach: "shared", location: "src/elsewhere.ts" }),
            change({ kind: "passive", location: "src/a.ts" }),
            change({ kind: "passive", location: "src/b.ts" }),
          ],
        });
        expect(finalVerdict(review, covered).verdict).toBe("agent");
      });

      it("counts as partial on a file coverage can't measure, or one the diff only deletes from", () => {
        const facts = makeFacts({
          files: [
            { path: "docs/a.md", additions: 3, deletions: 0 },
            { path: "src/a.ts", additions: 0, deletions: 9 },
          ],
        });
        for (const location of ["docs/a.md", "src/a.ts"]) {
          const review = makeReview({
            changes: [
              change({ kind: "logic", reach: "shared", location }),
              change({ kind: "passive", location: "src/a.ts" }),
            ],
          });
          expect(finalVerdict(review, facts).verdict).toBe("agent");
        }
      });

      it("counts as partial at a folder no changed file sits under, or a path that only prefixes one", () => {
        for (const location of ["lib/", "src/a"]) {
          const review = makeReview({
            changes: [
              change({ kind: "logic", reach: "shared", location }),
              change({ kind: "passive", location: "src/a.ts" }),
              change({ kind: "passive", location: "src/b.ts" }),
            ],
          });
          expect(finalVerdict(review, covered).verdict).toBe("agent");
        }
      });

      it("checks every changed file under a folder location", () => {
        const folder = sharedLogic({ location: "src/" });
        expect(finalVerdict(folder, covered).verdict).toBe("auto");
        const facts = withCoverage({ uncovered: [{ path: "src/b.ts", lines: "1" }] });
        expect(finalVerdict(folder, facts).verdict).toBe("agent");
      });

      it("never lowers an unproven claim", () => {
        const review = sharedLogic({ evidence: "unproven", check: "x" });
        const facts = withCoverage({ uncovered: [{ path: "src/a.ts", lines: "3-9" }] });
        expect(finalVerdict(review, facts)).toEqual({
          verdict: "human",
          why: ["very high impact"],
        });
      });
    });

    it("lets many passive changes merge on their own", () => {
      const review = makeReview({
        changes: [change({ kind: "passive", reach: "core", count: 200 })],
      });
      expect(finalVerdict(review, makeFacts()).verdict).toBe("auto");
    });
  });
});

describe("renderReport", () => {
  it("round-trips its data block, signature and all, through the comment body", () => {
    const { body, data, payload } = renderReport(makeReview(), makeFacts(), TARGET);
    expect(body.startsWith(REPORT_MARKER)).toBe(true);
    expect(parseSignedReport(withSignature(body, "c2ln"))).toEqual({
      data,
      payload,
      signature: "c2ln",
    });
  });

  it("names the repo, PR and commit in what gets signed", () => {
    const { data, payload } = renderReport(makeReview(), makeFacts(), TARGET);
    expect(data.issuedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(data).toMatchObject({
      version: 2,
      repo: "bennettaur/yarvis",
      pr: 7,
      headSha: "b".repeat(40),
    });
    expect(JSON.parse(Buffer.from(payload, "base64").toString("utf8"))).toEqual(data);
  });

  it("lists failing checks, including coverage, in the data the gate reads", () => {
    const review = makeReview({
      dimensions: { ...makeReview().dimensions, tests: { status: "concern", note: "thin" } },
    });
    const facts = makeFacts({ coverage: { ...makeFacts().coverage, ratio: 0.2 } });
    expect(renderReport(review, facts, TARGET).data.flagged).toEqual(["tests", "coverage"]);
  });

  it("shows the mutation score with the tests and lists surviving mutants in details", () => {
    const facts = makeFacts({
      mutation: {
        score: 0.5,
        killed: 5,
        survived: [
          "src/a.ts:10 BlockStatement",
          "src/a.ts:9 BlockStatement",
          "src/a.ts:1 X",
          "src/a.ts:2 X",
          "src/a.ts:3 X",
        ],
        skippedRanges: 2,
      },
    });
    const { body, data } = renderReport(makeReview(), facts, TARGET);
    expect(body).toContain("50% of 10 mutants on changed lines caught (2 ranges not mutated)");
    const details = body.split("<details>")[1];
    // Numeric order, so line 9 comes before line 10.
    expect(details.indexOf("src/a.ts:9 ")).toBeLessThan(details.indexOf("src/a.ts:10 "));
    expect(details).toContain("**Changed lines the tests run but don't check**");
    expect(details).toContain("Add or tighten a test");
    expect(data.flagged).toContain("mutation");
  });

  it("says what to do with new tests that pass without the change", () => {
    const facts = makeFacts({
      baseline: { detecting: 1, notDetecting: ["src/a.test.ts > renders"], failingOnHead: [] },
    });
    const details = renderReport(makeReview(), facts, TARGET).body.split("<details>")[1];
    expect(details).toContain("**New or changed tests that pass without the change**");
    expect(details).toContain("make each one check the new behavior");
  });

  it("says nothing about mutation when no mutant ran", () => {
    const facts = makeFacts({
      mutation: { score: null, killed: 0, survived: [], skippedRanges: 0 },
    });
    const { body, data } = renderReport(makeReview(), facts, TARGET);
    expect(body).not.toContain("mutants");
    expect(data.flagged).not.toContain("mutation");
  });

  it("keeps minor findings out of the headline section", () => {
    const review = makeReview({
      verdict: "agent",
      findings: [
        { severity: "major", title: "Races on unmount", detail: "…" },
        { severity: "minor", title: "Rename a variable", detail: "…" },
      ],
    });
    const { body } = renderReport(review, makeFacts(), TARGET);
    const [headline, details] = body.split("<details>");
    expect(headline).toContain("Races on unmount");
    expect(headline).not.toContain("Rename a variable");
    expect(details).toContain("Rename a variable");
    expect(details).toContain("still worth fixing in this PR");
  });
});

describe("renderReport's impact", () => {
  const coreLogic = change({
    title: "Retry failed sends",
    location: "sidecar/src/chat/agent.ts:120",
    kind: "logic",
    reach: "core",
    evidence: "partial",
    check: "A retry can't send the message twice",
  });
  const reach = [
    {
      path: "sidecar/src/chat/agent.ts",
      importers: 8,
      otherAreas: 5,
      suggested: "core" as const,
    },
  ];

  it("lists high-impact changes with what to check and how far their file reaches", () => {
    const review = makeReview({ changes: [coreLogic, change({ kind: "passive", count: 4 })] });
    const { body, data } = renderReport(review, makeFacts({ reach }), TARGET);
    expect(body).toContain("**Impact:** high (4/5) · 4 passive, 1 logic change\n");
    expect(body).toContain(
      "- **Retry failed sends** `sidecar/src/chat/agent.ts:120`: logic, core; its file has 8 importers in 5 other areas, partly tested. Check: A retry can't send the message twice",
    );
    expect(data.impactBand).toBe(4);
    expect(parseSignedReport(withSignature(body, "c2ln"))?.data.impactBand).toBe(4);
  });

  it("signs a very high band so the gate can read it back", () => {
    const review = makeReview({ changes: [coreLogic, { ...coreLogic, kind: "interface" }] });
    const { body } = renderReport(review, makeFacts(), TARGET);
    expect(parseSignedReport(withSignature(body, "c2ln"))?.data.impactBand).toBe(5);
  });

  it("describes ranges, bare paths, sensitivity and folded changes in the details", () => {
    const review = makeReview({
      changes: [
        change({
          title: "Tighten token checks",
          location: "sidecar/src/chat/agent.ts:12-20",
          sensitive: true,
          count: 3,
        }),
        change({ title: "Docs", location: "docs/", kind: "passive" }),
      ],
    });
    const facts = makeFacts({
      files: [{ path: "sidecar/src/chat/agent.ts", additions: 9, deletions: 0 }],
      reach: [{ ...reach[0], importers: 1, otherAreas: 1 }],
    });
    const { body } = renderReport(review, facts, TARGET);
    expect(body).toContain("**Every change, by impact**");
    expect(body).toContain(
      "`sidecar/src/chat/agent.ts:12-20`: addition, leaf; its file has 1 importer in 1 other area, proven by tests, sensitive (3 like it)",
    );
    expect(body).toContain("Docs `docs/`: passive, leaf, proven by tests");
  });

  it("says when the number of changes raised the band", () => {
    const review = makeReview({
      changes: [change({ kind: "addition", reach: "local", count: 9 })],
    });
    const { body } = renderReport(review, makeFacts(), TARGET);
    expect(body).toContain("raised from low by the number of changes");
    expect(body).not.toContain("### Needs attention");
  });
});

describe("coverageStatus", () => {
  const coverage = (ratio: number | null, notLoaded: string[] = []) => ({
    ...makeFacts().coverage,
    ratio,
    notLoaded,
  });

  it("passes at 80% and fails below 50%", () => {
    expect(coverageStatus(coverage(0.8))).toBe("pass");
    expect(coverageStatus(coverage(0.5))).toBe("concern");
    expect(coverageStatus(coverage(0.49))).toBe("fail");
  });

  it("flags changed files no test loads, which the ratio can't see", () => {
    expect(coverageStatus(coverage(1, ["src/new.ts"]))).toBe("concern");
    expect(coverageStatus(coverage(null, ["src/new.ts"]))).toBe("fail");
  });

  it("fails when a suite the change needed ran no tests", () => {
    expect(coverageStatus({ ...coverage(0.9), noTestsRan: ["sidecar/src/a.ts"] })).toBe("fail");
  });

  it("has nothing to say when no executable line changed", () => {
    expect(coverageStatus(coverage(null))).toBe("n/a");
  });
});

describe("inline", () => {
  it("leaves no HTML tag or comment able to open", () => {
    expect(inline("a <!-- yarvis-verify-data x --> <b>b</b> & c")).toBe(
      "a &lt;!-- yarvis-verify-data x --&gt; &lt;b&gt;b&lt;/b&gt; &amp; c",
    );
  });

  it("escapes backslashes, so one can't cancel the pipe escape", () => {
    expect(inline("a\\|b")).toBe("a\\\\\\|b");
  });

  it("keeps text from breaking the table or pinging people", () => {
    expect(inline("a | b\nc @someone")).toBe("a \\| b c @​someone");
  });
});

describe("Review", () => {
  it("needs a change scored high to say what to check", () => {
    const review = makeReview({
      changes: [change({ kind: "logic", reach: "core", evidence: "partial", check: "" })],
    });
    expect(Review.safeParse(review).success).toBe(false);
    expect(Review.safeParse(makeReview()).success).toBe(true);
    const named = makeReview({
      changes: [change({ kind: "logic", reach: "core", evidence: "partial", check: "x" })],
    });
    expect(Review.safeParse(named).success).toBe(true);
  });

  it("takes several changes and folded counts, but not none or a count of 0", () => {
    const parses = (changes: unknown[]) => Review.safeParse({ ...makeReview(), changes }).success;
    expect(parses([change(), change({ count: 20 })])).toBe(true);
    expect(parses([change({ count: 0 })])).toBe(false);
    expect(parses([])).toBe(false);
  });

  it("defaults a change to not sensitive, a count of 1 and no check", () => {
    const { sensitive: _s, count: _c, check: _k, ...bare } = change();
    const parsed = Review.parse({ ...makeReview(), changes: [bare] });
    expect(parsed.changes[0]).toMatchObject({ sensitive: false, count: 1, check: "" });
  });

  it("only accepts screenshots that are absolute image paths", () => {
    const withShot = (path: string) =>
      Review.safeParse({ ...makeReview(), screenshots: [{ path, caption: "x" }] }).success;
    expect(withShot("/tmp/verify/7/after.png")).toBe(true);
    expect(withShot("/Users/me/.ssh/id_ed25519")).toBe(false);
    expect(withShot("after.png")).toBe(false);
  });
});

describe("parseSignedReport", () => {
  it("returns null without a data block, without a signature, or with broken data", () => {
    const { body } = renderReport(makeReview(), makeFacts(), TARGET);
    expect(parseSignedReport(`${REPORT_MARKER}\nhand-written`)).toBeNull();
    expect(parseSignedReport(body)).toBeNull();
    expect(
      parseSignedReport(
        "<!-- yarvis-verify-data bm90IGpzb24= -->\n<!-- yarvis-verify-sig c2ln -->",
      ),
    ).toBeNull();
  });
});
