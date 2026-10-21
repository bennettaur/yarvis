import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
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
/** Requests the section made, so a test can assert what it wrote. */
const calls: { method: string; body?: string }[] = [];
/** When set, the next PATCH answers with this status instead of succeeding. */
let nextPatchStatus: number | null = null;

/**
 * `mock.module` replaces the module for the whole test process, so the real
 * exports are spread back in: a stub that redefines `ensureOk` silently
 * replaces what `api.test.ts` is asserting about (see `SpecialistSection.test.tsx`).
 */
const actualApi = await import("../lib/api");

mock.module("../lib/api", () => ({
  ...actualApi,
  sidecarFetch: async (url: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    calls.push({ method, body: init.body as string | undefined });
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
    if (method === "PATCH") {
      config = { ...config, ...JSON.parse(init.body as string) };
    }
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
  config = { guide: null, ask: null };
});

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
});
