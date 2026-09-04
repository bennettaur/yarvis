import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml } from "../test/render";
import ModelCatalogSection from "./ModelCatalogSection";

const CATALOG = {
  capabilities: ["chat", "stt", "tts", "vision", "embed"],
  defaults: {
    gemini: [
      { id: "gemini-3.5-flash", capabilities: ["chat", "vision", "stt"] },
      { id: "gemini-2.5-flash-preview-tts", capabilities: ["tts"] },
    ],
  },
  models: [
    {
      id: "row-1",
      providerId: "anthropic",
      modelId: "claude-sonnet-4-6",
      capabilities: ["chat"],
      enabled: true,
      sortOrder: 0,
    },
  ],
};

const PROVIDERS = [
  { id: "gemini", label: "Gemini", models: [], available: true },
  { id: "anthropic", label: "Anthropic", models: [], available: true },
];

/** Requests the section made, so a test can assert what it wrote. */
const calls: { url: string; method: string; body?: string }[] = [];

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: a naive stub here would leak
  // into any other test file that runs in the same process (`mock.module` is
  // process-global, not file-scoped) and break its assertions about the
  // actual error-detail-extraction behavior.
  ensureOk: async (res: Response, context: string) => {
    if (res.ok) return;
    let raw = "";
    try {
      raw = (await res.text()).trim();
    } catch {
      // no body to read
    }
    let detail: string | null = null;
    if (raw) {
      try {
        const body = JSON.parse(raw) as { error?: unknown };
        const err = body?.error;
        if (typeof err === "string") {
          detail = err;
        } else if (err && typeof err === "object") {
          const flat = err as { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
          const parts: string[] = [];
          if (Array.isArray(flat.formErrors)) parts.push(...flat.formErrors);
          for (const [field, msgs] of Object.entries(flat.fieldErrors ?? {})) {
            if (Array.isArray(msgs) && msgs.length) parts.push(`${field}: ${msgs.join(", ")}`);
          }
          if (parts.length) detail = parts.join("; ");
        }
        if (detail === null) detail = raw;
      } catch {
        detail = raw;
      }
    }
    throw new Error(
      detail ? `${context} failed (${res.status}): ${detail}` : `${context} failed: ${res.status}`,
    );
  },
  getHealth: async () => ({
    status: "ok",
    service: "sidecar",
    uptimeMs: 0,
    ready: true,
    phase: "ready" as const,
  }),
  waitForSidecarReady: async () => {},
  getStatus: async () => ({
    service: "sidecar",
    databaseConfigured: true,
    providers: { anthropic: false, gemini: false, cerebras: false, huggingface: false },
  }),
  getDbHealth: async () => ({ configured: true, reachable: true }),
  streamSSE: async function* streamSSE() {},
  sidecarFetch: async (url: string, init: RequestInit = {}) => {
    calls.push({ url, method: init.method ?? "GET", body: init.body as string | undefined });
    const body = url.startsWith("/api/chat/providers") ? PROVIDERS : CATALOG;
    return new Response(JSON.stringify(body), {
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
});

describe("ModelCatalogSection", () => {
  it("shows a provider's built-in list as such until it is edited", async () => {
    const html = await renderToHtml(createElement(ModelCatalogSection));
    expect(html).toContain("gemini-3.5-flash");
    expect(html).toContain("gemini-2.5-flash-preview-tts");
    expect(html).toContain("built-in list");
  });

  it("marks a provider that has rows of its own as customised", async () => {
    const html = await renderToHtml(createElement(ModelCatalogSection));
    expect(html).toContain("claude-sonnet-4-6");
    expect(html).toContain("customised");
  });

  it("copies the built-in list into settings before adding to it", async () => {
    // Otherwise the first added model would replace the whole default list,
    // silently deleting every model beside it.
    const mounted = await mountForInteraction(createElement(ModelCatalogSection));
    unmount = mounted.unmount;

    const input = [...mounted.host.querySelectorAll("input")].find(
      (i) => i.placeholder === "model id",
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.bind(
      input,
    );
    setter?.("gemini-9-flash");
    input?.dispatchEvent(new Event("input", { bubbles: true }));

    const add = [...mounted.host.querySelectorAll("button")].find(
      (b) => b.textContent === "Add model",
    );
    add?.click();
    await new Promise((resolve) => setTimeout(resolve, 50));

    const saved = calls
      .filter((c) => c.method === "PUT")
      .map((c) => JSON.parse(c.body ?? "{}") as { modelId: string });
    expect(saved.map((s) => s.modelId)).toEqual([
      "gemini-3.5-flash",
      "gemini-2.5-flash-preview-tts",
      "gemini-9-flash",
    ]);
  });
});
