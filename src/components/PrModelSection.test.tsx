import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import { resetSidecarApi, stubSidecarApi } from "../test/sidecarApi";
import PrModelSection from "./PrModelSection";

const PROVIDERS = [
  {
    id: "cerebras",
    label: "Cerebras",
    available: true,
    models: [{ id: "llama-3.3-70b", capabilities: ["chat"] }],
  },
];

let config: Record<string, unknown> = { guide: null, ask: null };
const VERIFICATION_DEFAULTS = {
  maxBudgetUsd: 2,
  sections: {},
  harnesses: [{ id: "claude", name: "Claude" }],
  sectionDefaults: [
    { section: "risk", label: "Risk", model: "opus", effort: "high" },
    { section: "comments", label: "Comment quality", model: "haiku", effort: "low" },
  ],
};
let verification: Record<string, unknown> = { ...VERIFICATION_DEFAULTS };
const REREVIEW_DEFAULTS = { model: "sonnet", maxBudgetUsd: 1, autoStart: false };
let rereview: Record<string, unknown> = { ...REREVIEW_DEFAULTS };
/** Requests the section made, so a test can assert what it wrote. */
const calls: { url: string; method: string; body?: string }[] = [];
/** When set, the next PATCH answers with this status instead of succeeding. */
let nextPatchStatus: number | null = null;

stubSidecarApi({
  sidecarFetch: async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body as string | undefined });
    if (url.startsWith("/api/chat/providers")) {
      return new Response(JSON.stringify(PROVIDERS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/pr-models/verification") {
      if (method === "PATCH") {
        const patch = JSON.parse(init.body as string);
        verification = {
          ...verification,
          ...patch,
          sections: { ...(verification.sections as object), ...patch.sections },
        };
      }
      return new Response(JSON.stringify(verification), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url === "/api/pr-models/rereview") {
      if (method === "PATCH") rereview = { ...rereview, ...JSON.parse(init.body as string) };
      return new Response(JSON.stringify(rereview), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "PATCH" && nextPatchStatus !== null) {
      const status = nextPatchStatus;
      nextPatchStatus = null;
      return new Response(JSON.stringify({ error: "boom" }), { status });
    }
    if (method === "PATCH") {
      config = { ...config, ...JSON.parse(init.body as string) };
    }
    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
});

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  calls.length = 0;
  nextPatchStatus = null;
  config = { guide: null, ask: null };
  verification = { ...VERIFICATION_DEFAULTS };
  rereview = { ...REREVIEW_DEFAULTS };
});

/** Sets a form control's value the way React notices, then fires `event`. */
function enter(el: HTMLInputElement | HTMLSelectElement, value: string, event: string) {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement : HTMLInputElement;
  Object.getOwnPropertyDescriptor(proto.prototype, "value")?.set?.call(el, value);
  el.dispatchEvent(new Event(event, { bubbles: true }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("PrModelSection", () => {
  it("shows every feature defaulting to the chat model", async () => {
    const text = textOf(await renderToHtml(createElement(PrModelSection)));
    expect(text).toContain("Guided review");
    expect(text).toContain("Line questions");
    expect(text).toContain("Default chat model");
  });

  it("saves a feature's model on picking a provider", async () => {
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;

    const providerSelect = mounted.host.querySelectorAll("select")[0] as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.bind(
      providerSelect,
    );
    setter?.("cerebras");
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    const saved = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({
      guide: { provider: "cerebras", model: "llama-3.3-70b" },
    });
  });

  it("reverts the optimistic update when the save fails", async () => {
    nextPatchStatus = 503;
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;

    const providerSelect = mounted.host.querySelectorAll("select")[0] as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.bind(
      providerSelect,
    );
    setter?.("cerebras");
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(mounted.host.textContent).toContain("failed");
    // Reverted to unset rather than showing the picked provider as if it saved.
    expect((mounted.host.querySelectorAll("select")[0] as HTMLSelectElement).value).toBe("");
  });

  it("saves a verification check's model and effort, and the report's budget", async () => {
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(mounted.host.textContent).toContain("Verification report");
    // One model for the whole report is gone: each check has its own.
    expect(mounted.host.querySelector('[aria-label="Verification report model"]')).toBeNull();

    const model = mounted.host.querySelector('[aria-label="Risk model"]') as HTMLSelectElement;
    expect(model.value).toBe("");
    expect(model.textContent).toContain("Default (Claude Opus)");
    enter(model, "sonnet", "change");
    await settle();
    const effort = mounted.host.querySelector('[aria-label="Risk effort"]') as HTMLSelectElement;
    enter(effort, "max", "change");
    await settle();
    // Back to the default model, keeping the effort.
    enter(
      mounted.host.querySelector('[aria-label="Risk model"]') as HTMLSelectElement,
      "",
      "change",
    );
    await settle();

    const budget = mounted.host.querySelector(
      '[aria-label="Verification report budget in US dollars"]',
    ) as HTMLInputElement;
    // No upper limit: the budget only warns.
    enter(budget, "50", "input");
    budget.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();

    const saves = calls
      .filter((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(saves).toEqual([
      { sections: { risk: { model: "sonnet" } } },
      { sections: { risk: { model: "sonnet", effort: "max" } } },
      { sections: { risk: { effort: "max" } } },
      { maxBudgetUsd: 50 },
    ]);
  });

  it("offers a harness only when there is more than the built-in agent, and saves the pick", async () => {
    const harnessSelect = (host: HTMLElement) =>
      host.querySelector('[aria-label="Verification harness"]') as HTMLSelectElement | null;
    let mounted = await mountForInteraction(createElement(PrModelSection));
    await settle();
    expect(harnessSelect(mounted.host)).toBeNull();
    mounted.unmount();

    verification = {
      ...VERIFICATION_DEFAULTS,
      harnesses: [
        { id: "claude", name: "Claude" },
        { id: "bedrock", name: "Bedrock" },
      ],
    };
    mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    const select = harnessSelect(mounted.host) as HTMLSelectElement;
    expect(select.value).toBe("claude");
    enter(select, "bedrock", "change");
    await settle();
    enter(harnessSelect(mounted.host) as HTMLSelectElement, "claude", "change");
    await settle();
    const saves = calls
      .filter((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    // The built-in agent is saved as no harness at all.
    expect(saves).toEqual([{ harness: "bedrock" }, { harness: null }]);
  });

  it("asks an OpenCode harness for a model per tier, saving only one that reads as provider/model", async () => {
    const tierInput = (host: HTMLElement, tier: string) =>
      host.querySelector(
        `[aria-label="OpenCode model for the ${tier} tier"]`,
      ) as HTMLInputElement | null;
    let mounted = await mountForInteraction(createElement(PrModelSection));
    await settle();
    // Not for a Claude Code harness, whose tiers are Claude's own models.
    expect(tierInput(mounted.host, "Opus")).toBeNull();
    mounted.unmount();

    verification = {
      ...VERIFICATION_DEFAULTS,
      harness: "oc",
      harnesses: [
        { id: "claude", name: "Claude", kind: "claude-code" },
        { id: "oc", name: "OpenCode", kind: "opencode" },
      ],
      harnessModels: { oc: { haiku: "opencode/beam-free" } },
    };
    mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(tierInput(mounted.host, "Haiku")?.value).toBe("opencode/beam-free");
    const opus = tierInput(mounted.host, "Opus") as HTMLInputElement;
    enter(opus, "not a model", "input");
    opus.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    enter(opus, "anthropic/claude-opus-5-5#high", "input");
    opus.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    const saves = calls
      .filter((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(saves).toEqual([
      {
        harnessModels: {
          oc: { haiku: "opencode/beam-free", opus: "anthropic/claude-opus-5-5#high" },
        },
      },
    ]);
  });

  it("asks a Pi harness for a model per tier, with its thinking level on the model", async () => {
    verification = {
      ...VERIFICATION_DEFAULTS,
      harness: "pi",
      harnesses: [
        { id: "claude", name: "Claude", kind: "claude-code" },
        { id: "pi", name: "Pi", kind: "pi" },
      ],
    };
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(mounted.host.textContent).toContain(":level");
    const sonnet = mounted.host.querySelector(
      '[aria-label="Pi model for the Sonnet tier"]',
    ) as HTMLInputElement;
    enter(sonnet, "anthropic/claude-sonnet-5-5:high", "input");
    sonnet.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    const saves = calls
      .filter((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(saves).toEqual([
      { harnessModels: { pi: { sonnet: "anthropic/claude-sonnet-5-5:high" } } },
    ]);
  });

  it("shows a saved harness that is gone, so it can be changed", async () => {
    verification = { ...VERIFICATION_DEFAULTS, harness: "deleted" };
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    const select = mounted.host.querySelector(
      '[aria-label="Verification harness"]',
    ) as HTMLSelectElement;
    // Shown even with only the built-in agent left, and not as if it were that.
    expect(select.value).toBe("deleted");
    expect(select.textContent).toContain("deleted (no longer saved; checks fail)");
    enter(select, "claude", "change");
    await settle();
    const saves = calls
      .filter((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(saves).toEqual([{ harness: null }]);
  });

  it("saves the What's changed summary's own budget and auto-start", async () => {
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();

    const budget = mounted.host.querySelector(
      `[aria-label="What's changed budget in US dollars"]`,
    ) as HTMLInputElement;
    expect(budget.value).toBe("1");
    enter(budget, "0.5", "input");
    budget.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();
    const auto = mounted.host.querySelector('input[type="checkbox"]') as HTMLInputElement;
    expect(auto.checked).toBe(false);
    auto.click();
    await settle();

    const saves = calls
      .filter((c) => c.url === "/api/pr-models/rereview" && c.method === "PATCH")
      .map((c) => JSON.parse(c.body ?? "{}"));
    expect(saves).toEqual([{ maxBudgetUsd: 0.5 }, { autoStart: true }]);
    expect(calls.some((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")).toBe(
      false,
    );
  });

  it("refuses a budget below the minimum without saving it", async () => {
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();

    const budget = mounted.host.querySelector(
      '[aria-label="Verification report budget in US dollars"]',
    ) as HTMLInputElement;
    enter(budget, "0.1", "input");
    budget.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    await settle();

    expect(mounted.host.textContent).toContain("The budget must be at least $0.25.");
    expect(budget.value).toBe("2");
    expect(calls.some((c) => c.url === "/api/pr-models/verification" && c.method === "PATCH")).toBe(
      false,
    );
  });
});

afterAll(resetSidecarApi);
