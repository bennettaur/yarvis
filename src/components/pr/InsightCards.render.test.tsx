import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrInsight } from "../../lib/pr/insights";
import { renderToHtml } from "../../test/render";
import InsightBlock, { hasInsightsAt, insightsAtLine } from "./InsightCards";
import type { InsightsController, LineSelection } from "./usePrInsights";

const insight = (over: Partial<PrInsight> = {}): PrInsight => ({
  id: "i1",
  path: "src/a.ts",
  startLine: 10,
  endLine: 12,
  headSha: "a".repeat(40),
  question: "why the guard?",
  answer: "it stops a null slipping through",
  postedAt: null,
  createdAt: "",
  ...over,
});

function controller(
  insights: PrInsight[] = [],
  asking: LineSelection | null = null,
): InsightsController {
  const byPath = new Map<string, PrInsight[]>();
  for (const i of insights) byPath.set(i.path, [...(byPath.get(i.path) ?? []), i]);
  return {
    byPath,
    loading: false,
    error: null,
    asking,
    openAsk: () => {},
    closeAsk: () => {},
    pending: false,
    submit: async () => {},
    post: async () => {},
    remove: async () => {},
  };
}

const render = (ctrl: InsightsController, line: number | null, currentSha = "a".repeat(40)) =>
  renderToHtml(
    createElement(InsightBlock, { path: "src/a.ts", line, controller: ctrl, currentSha }),
  );

describe("insightsAtLine", () => {
  // Anchored to the last line of the range, so a multi-line question renders
  // once at the bottom of what it covers rather than on every line.
  it("matches on the end of the range", () => {
    const list = [insight()];
    expect(insightsAtLine(list, 12)).toHaveLength(1);
    expect(insightsAtLine(list, 10)).toHaveLength(0);
    expect(insightsAtLine(list, null)).toHaveLength(0);
    expect(insightsAtLine(undefined, 12)).toHaveLength(0);
  });
});

describe("hasInsightsAt", () => {
  it("is true for a line with an insight", () => {
    expect(hasInsightsAt(controller([insight()]), "src/a.ts", 12)).toBe(true);
  });

  it("is true where the composer is open", () => {
    const asking = { path: "src/a.ts", startLine: 3, endLine: 5, selection: "" };
    expect(hasInsightsAt(controller([], asking), "src/a.ts", 5)).toBe(true);
  });

  it("is false everywhere else", () => {
    const ctrl = controller([insight()]);
    expect(hasInsightsAt(ctrl, "src/a.ts", 11)).toBe(false);
    expect(hasInsightsAt(ctrl, "src/other.ts", 12)).toBe(false);
    expect(hasInsightsAt(ctrl, "src/a.ts", null)).toBe(false);
  });
});

describe("InsightBlock", () => {
  it("renders the question and its answer", async () => {
    const html = await render(controller([insight()]), 12);
    expect(html).toContain("why the guard?");
    expect(html).toContain("it stops a null slipping through");
  });

  it("renders nothing on a line with none", async () => {
    expect(await render(controller([insight()]), 11)).toBe("");
  });

  // An insight is private until posted, so it must not look like a review
  // thread the author can already see.
  it("offers to post an insight that has not been shared", async () => {
    const html = await render(controller([insight()]), 12);
    expect(html).toContain("Post");
    expect(html).not.toContain("Posted to the PR");
  });

  it("shows a posted insight as shared instead of offering to post again", async () => {
    const html = await render(controller([insight({ postedAt: "2026-01-01" })]), 12);
    expect(html).toContain("Posted to the PR");
  });

  // An answer written against an older commit describes lines that have since
  // moved, so it says so rather than being quietly trusted.
  it("flags an answer the pull request has moved past", async () => {
    const html = await render(controller([insight()]), 12, "b".repeat(40));
    expect(html).toContain("Out of date");
  });

  it("does not flag when the head commit is unknown", async () => {
    const html = await render(controller([insight()]), 12, "");
    expect(html).not.toContain("Out of date");
  });

  it("renders the composer where it is open", async () => {
    const asking = { path: "src/a.ts", startLine: 3, endLine: 5, selection: "" };
    const html = await render(controller([], asking), 5);
    expect(html).toContain("Ask about these lines");
  });

  it("shows that a question is being worked on", async () => {
    const asking = { path: "src/a.ts", startLine: 5, endLine: 5, selection: "" };
    const html = await renderToHtml(
      createElement(InsightBlock, {
        path: "src/a.ts",
        line: 5,
        controller: { ...controller([], asking), pending: true },
        currentSha: "",
      }),
    );
    expect(html).toContain("Looking…");
    expect(html).toContain("Reading the code around this");
  });
});
