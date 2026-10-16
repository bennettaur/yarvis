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
  config = { model: null, autoApproveTools: false };
});

async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 50));
}

describe("DecisionModelSection", () => {
  it("lists only decision-capable models", async () => {
    const mounted = await mountForInteraction(createElement(DecisionModelSection));
    unmount = mounted.unmount;
    await settle();
    expect(calls.some((c) => c.url === "/api/chat/providers?capability=decision")).toBe(true);
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
});
