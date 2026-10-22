import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../test/render";
import ComplexityModelSection from "./ComplexityModelSection";

const PROVIDERS = [
  {
    id: "cerebras",
    label: "Cerebras",
    available: true,
    models: [{ id: "llama-3.3-70b", capabilities: ["chat"] }],
  },
  {
    id: "anthropic",
    label: "Anthropic",
    available: true,
    models: [
      { id: "claude-opus-4-7", capabilities: ["chat", "reasoning"] },
      { id: "claude-haiku-4-5", capabilities: ["chat"] },
    ],
  },
];

let config: Record<string, unknown> = { low: null, medium: null, max: null };
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
  config = { low: null, medium: null, max: null };
});

describe("ComplexityModelSection", () => {
  it("shows every tier defaulting to the chat model", async () => {
    const text = textOf(await renderToHtml(createElement(ComplexityModelSection)));
    expect(text).toContain("Cheap, fast calls");
    expect(text).toContain("Default chat model");
  });

  it("saves a tier's model on picking a provider", async () => {
    const mounted = await mountForInteraction(createElement(ComplexityModelSection));
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
      low: { provider: "cerebras", model: "llama-3.3-70b" },
    });
  });

  it("reverts the optimistic update when the save fails", async () => {
    nextPatchStatus = 503;
    const mounted = await mountForInteraction(createElement(ComplexityModelSection));
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

  describe("effort", () => {
    /** Picks `value` in `select` the way a user would. */
    async function choose(select: Element | null | undefined, value: string) {
      const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
      setter?.call(select, value);
      select?.dispatchEvent(new Event("change", { bubbles: true }));
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    it("offers an effort only for a model tagged reasoning", async () => {
      config = {
        low: { provider: "cerebras", model: "llama-3.3-70b" },
        medium: null,
        max: { provider: "anthropic", model: "claude-opus-4-7" },
      };
      const mounted = await mountForInteraction(createElement(ComplexityModelSection));
      unmount = mounted.unmount;
      expect(mounted.host.querySelector('select[aria-label="low effort"]')).toBeNull();
      expect(mounted.host.querySelector('select[aria-label="max effort"]')).not.toBeNull();
    });

    it("saves the chosen effort with the tier's model, and clears it on Default", async () => {
      config = {
        low: null,
        medium: null,
        max: { provider: "anthropic", model: "claude-opus-4-7" },
      };
      const mounted = await mountForInteraction(createElement(ComplexityModelSection));
      unmount = mounted.unmount;

      await choose(mounted.host.querySelector('select[aria-label="max effort"]'), "high");
      await choose(mounted.host.querySelector('select[aria-label="max effort"]'), "");

      const saved = calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body ?? ""));
      expect(saved).toEqual([
        { max: { provider: "anthropic", model: "claude-opus-4-7", effort: "high" } },
        { max: { provider: "anthropic", model: "claude-opus-4-7" } },
      ]);
    });

    it("drops the effort when the tier moves to a model that doesn't take one", async () => {
      config = {
        low: null,
        medium: null,
        max: { provider: "anthropic", model: "claude-opus-4-7", effort: "high" },
      };
      const mounted = await mountForInteraction(createElement(ComplexityModelSection));
      unmount = mounted.unmount;

      const modelSelect = [...mounted.host.querySelectorAll("select")].find((s) =>
        [...s.options].some((o) => o.value === "claude-haiku-4-5"),
      );
      await choose(modelSelect, "claude-haiku-4-5");

      const saved = calls.filter((c) => c.method === "PATCH").map((c) => JSON.parse(c.body ?? ""));
      expect(saved).toEqual([{ max: { provider: "anthropic", model: "claude-haiku-4-5" } }]);
    });
  });
});
