import { describe, expect, it } from "bun:test";
import { createElement } from "react";
import type { PrGuide } from "../../lib/pr/guide";
import { renderToHtml } from "../../test/render";
import PrGuidePanel, { PrGuideStart, stepLocation } from "./PrGuidePanel";
import type { GuideController } from "./usePrGuide";

const steps = [
  { path: "src/api.ts", startLine: 10, endLine: 20, explanation: "the request arrives here" },
  {
    path: "src/db.ts",
    startLine: 5,
    endLine: 5,
    explanation: "and is finally written here",
    context: "the write goes through the same pool as everything else",
  },
];

const guide = (over: Partial<PrGuide> = {}): PrGuide => ({
  headSha: "a".repeat(40),
  steps,
  currentStep: 0,
  stale: false,
  createdAt: "",
  ...over,
});

function controller(over: Partial<GuideController> = {}): GuideController {
  const g = over.guide === undefined ? guide() : over.guide;
  return {
    guide: g,
    step: g?.steps[g.currentStep] ?? null,
    loading: false,
    generating: false,
    error: null,
    generate: async () => {},
    next: () => {},
    back: () => {},
    goTo: () => {},
    dismiss: async () => {},
    focusNonce: 0,
    ...over,
  };
}

const render = (over: Partial<GuideController> = {}) =>
  renderToHtml(createElement(PrGuidePanel, { guide: controller(over) }));

describe("stepLocation", () => {
  it("renders a range", () => {
    expect(stepLocation({ path: "a.ts", startLine: 10, endLine: 20 })).toBe("a.ts:10–20");
  });

  // A one-line step reads better as a single number than as "5–5".
  it("collapses a single-line range", () => {
    expect(stepLocation({ path: "a.ts", startLine: 5, endLine: 5 })).toBe("a.ts:5");
  });

  it("falls back to the path for a whole-file step", () => {
    expect(stepLocation({ path: "a.ts", startLine: null, endLine: null })).toBe("a.ts");
  });
});

describe("PrGuidePanel", () => {
  it("shows the reader's position and the step's explanation", async () => {
    const html = await render();
    expect(html).toContain("Step 1 of 2");
    expect(html).toContain("the request arrives here");
    expect(html).toContain("src/api.ts:10–20");
  });

  // Nothing to render before a guide exists; the start control covers that.
  it("renders nothing without a guide", async () => {
    expect(await render({ guide: null })).toBe("");
  });

  it("offers extra context only when the step carries some", async () => {
    expect(await render()).not.toContain("More");
    const withContext = await render({ guide: guide({ currentStep: 1 }) });
    expect(withContext).toContain("More");
    expect(withContext).toContain("the same pool as everything else");
  });

  /**
   * Walking off either end of the tour must not be offered.
   *
   * Matching a bare "disabled" would pass on the `disabled:opacity-40` class
   * every button carries, so this matches the rendered attribute — `disabled=""`
   * — which only appears when the prop is actually set.
   */
  const disabledButton = (label: string) =>
    new RegExp(`<button[^>]*\\bdisabled=""[^>]*>${label}</button>`);

  it("disables Back on the first step and Next on the last", async () => {
    const first = await render();
    expect(first).toMatch(disabledButton("Back"));
    expect(first).not.toMatch(disabledButton("Next"));

    const last = await render({ guide: guide({ currentStep: 1 }) });
    expect(last).toMatch(disabledButton("Next"));
    expect(last).not.toMatch(disabledButton("Back"));
  });

  it("marks the end of the tour on the last step", async () => {
    const html = await render({ guide: guide({ currentStep: 1 }) });
    expect(html).toContain("End of the tour");
  });

  // A guide generated against an older commit describes line numbers that have
  // since moved, so it says so rather than being quietly trusted.
  it("flags a guide the pull request has moved past", async () => {
    expect(await render()).not.toContain("Out of date");
    expect(await render({ guide: guide({ stale: true }) })).toContain("Out of date");
  });

  it("shows that a regeneration is under way", async () => {
    expect(await render({ generating: true })).toContain("Rebuilding…");
  });

  it("surfaces an error from the controller", async () => {
    expect(await render({ error: "no LLM provider is configured" })).toContain(
      "no LLM provider is configured",
    );
  });
});

describe("PrGuideStart", () => {
  const renderStart = (over: Partial<GuideController> = {}) =>
    renderToHtml(createElement(PrGuideStart, { guide: controller({ guide: null, ...over }) }));

  it("offers to build a guide when there is none", async () => {
    expect(await renderStart()).toContain("Guided review");
  });

  // Otherwise the review would show both an offer to start and a running tour.
  it("renders nothing once a guide exists", async () => {
    expect(await renderStart({ guide: guide() })).toBe("");
  });

  it("renders nothing while the guide is still loading", async () => {
    expect(await renderStart({ loading: true })).toBe("");
  });

  // The generation is an agent run over the whole change, so the wait needs
  // explaining rather than looking like the button did nothing.
  it("says what is happening during a generation", async () => {
    const html = await renderStart({ generating: true });
    expect(html).toContain("Working out a reading order");
    expect(html).toContain("takes a minute");
  });
});
