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
let verification: Record<string, unknown> = { model: "sonnet", maxBudgetUsd: 2 };
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
      if (method === "PATCH")
        verification = { ...verification, ...JSON.parse(init.body as string) };
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
  verification = { model: "sonnet", maxBudgetUsd: 2 };
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

  it("saves the verification report's model and budget", async () => {
    const mounted = await mountForInteraction(createElement(PrModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(mounted.host.textContent).toContain("Verification report");

    const model = mounted.host.querySelector(
      '[aria-label="Verification report model"]',
    ) as HTMLSelectElement;
    expect(model.value).toBe("sonnet");
    enter(model, "opus", "change");
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
    expect(saves).toEqual([{ model: "opus" }, { maxBudgetUsd: 50 }]);
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
