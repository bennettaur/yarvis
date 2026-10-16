import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../test/render";
import DecisionModelSection from "./DecisionModelSection";

const PROVIDERS = [
  {
    id: "custom:ollama",
    label: "Local Ollama",
    available: true,
    models: [{ id: "jev", capabilities: ["decision"] }],
  },
];

let config: Record<string, unknown> = { model: null, autoApproveTools: false };
/** When set, the next PATCH answers with this status instead of succeeding. */
let nextPatchStatus: number | null = null;
const calls: { url: string; method: string; body?: string }[] = [];

// Real exports spread back in: `mock.module` replaces the module for the whole process.
const actualApi = await import("../lib/api");

mock.module("../lib/api", () => ({
  ...actualApi,
  sidecarFetch: async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body as string | undefined });
    if (url.startsWith("/api/chat/providers")) {
      return new Response(JSON.stringify(PROVIDERS), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (method === "PATCH" && nextPatchStatus !== null) {
      const status = nextPatchStatus;
      nextPatchStatus = null;
      return new Response(JSON.stringify({ error: "boom" }), { status });
    }
    if (method === "PATCH") config = { ...config, ...JSON.parse(init.body as string) };
    return new Response(JSON.stringify(config), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
}));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
  calls.length = 0;
  nextPatchStatus = null;
  config = { model: null, autoApproveTools: false };
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

function pick(select: HTMLSelectElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.call(select, value);
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

const SAVED = { provider: "custom:ollama", model: "jev" };

describe("DecisionModelSection", () => {
  it("offers the providers' decision-capable models", async () => {
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(calls.some((c) => c.url === "/api/chat/providers?capability=decision")).toBe(true);
    expect(mounted.host.textContent).toContain("Local Ollama");
  });

  it("saves the first model on picking a provider", async () => {
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();

    const providerSelect = mounted.host.querySelectorAll("select")[0] as HTMLSelectElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set?.bind(
      providerSelect,
    );
    setter?.("custom:ollama");
    providerSelect.dispatchEvent(new Event("change", { bubbles: true }));
    await settle();

    const saved = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({
      model: { provider: "custom:ollama", model: "jev" },
    });
  });

  it("keeps auto mode off until a model is chosen", async () => {
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();
    const checkbox = mounted.host.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.disabled).toBe(true);
  });

  it("turns auto mode on once a model is chosen", async () => {
    config = { model: SAVED, autoApproveTools: false };
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();

    const checkbox = mounted.host.querySelector("input[type=checkbox]") as HTMLInputElement;
    expect(checkbox.disabled).toBe(false);
    checkbox.click();
    await settle();

    const saved = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({ autoApproveTools: true });
  });

  it("clears the model on picking None", async () => {
    config = { model: SAVED, autoApproveTools: true };
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();

    pick(mounted.host.querySelectorAll("select")[0] as HTMLSelectElement, "");
    await settle();

    const saved = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(saved?.body ?? "{}")).toEqual({ model: null });
  });

  it("reverts the optimistic update when the save fails", async () => {
    nextPatchStatus = 503;
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();

    pick(mounted.host.querySelectorAll("select")[0] as HTMLSelectElement, "custom:ollama");
    await settle();

    expect(mounted.host.textContent).toContain("failed");
    expect((mounted.host.querySelectorAll("select")[0] as HTMLSelectElement).value).toBe("");
  });

  it("says when the saved model can no longer be used", async () => {
    config = { model: { provider: "custom:gone", model: "old" }, autoApproveTools: true };
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(mounted.host.textContent).toContain("auto mode is off until you pick another");
  });
});
