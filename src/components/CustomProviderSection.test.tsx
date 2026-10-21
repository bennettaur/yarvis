import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction } from "../test/render";
import CustomProviderSection from "./CustomProviderSection";

const PROVIDER = {
  id: "p1",
  name: "litellm",
  baseUrl: "https://litellm.example.com/v1",
  apiKind: "openai",
  models: [
    { id: "bedrock-claude-opus-5-5", capabilities: ["chat"] },
    { id: "gpt-typo", capabilities: ["chat"] },
  ],
  headerNames: [],
  createdAt: "2026-10-21T00:00:00.000Z",
  updatedAt: "2026-10-21T00:00:00.000Z",
};

/** Requests the section made, so a test can assert what it wrote. */
const calls: { url: string; method: string; body?: string }[] = [];

function reply(url: string, method: string): unknown {
  if (url.endsWith("/test")) {
    return { ok: true, latencyMs: 42, models: ["bedrock-claude-opus-5-5", "other"] };
  }
  if (url.endsWith("/test-model")) {
    return {
      ok: false,
      latencyMs: 9,
      error: "Invalid JSON response (status 200)",
      detail: "body=...",
    };
  }
  if (method === "PATCH") return PROVIDER;
  return [PROVIDER];
}

mock.module("../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
  // Faithful copy of the real implementation: `mock.module` is process-global,
  // so a naive stub here would break other files' assertions about it.
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
    const method = init.method ?? "GET";
    calls.push({ url, method, body: init.body as string | undefined });
    return new Response(JSON.stringify(reply(url, method)), {
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

async function mount() {
  const mounted = await mountForInteraction(createElement(CustomProviderSection));
  unmount = mounted.unmount;
  return mounted.host;
}

function button(host: HTMLElement, text: string, index = 0): HTMLButtonElement | undefined {
  return [...host.querySelectorAll("button")].filter((b) => b.textContent === text)[index];
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("CustomProviderSection", () => {
  it("tests the connection and flags a configured model the proxy doesn't list", async () => {
    const host = await mount();
    button(host, "Test connection")?.click();
    await settle();

    expect(
      calls.some((c) => c.method === "POST" && c.url === "/api/custom-providers/p1/test"),
    ).toBe(true);
    expect(host.textContent).toContain("Connected in 42 ms");
    expect(host.textContent).toContain("The proxy doesn't list gpt-typo");
  });

  it("shows why a model test failed", async () => {
    const host = await mount();
    button(host, "Test", 0)?.click();
    await settle();

    const sent = calls.find((c) => c.url === "/api/custom-providers/p1/test-model");
    expect(JSON.parse(sent?.body ?? "{}")).toEqual({ model: "bedrock-claude-opus-5-5" });
    expect(host.textContent).toContain("Invalid JSON response (status 200)");
  });

  it("saves a model's capability tags from the editor", async () => {
    const host = await mount();
    button(host, "Edit")?.click();
    await settle();

    // The first model's row in the editor, then its `reasoning` checkbox.
    const row = [...host.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("bedrock-claude-opus-5-5"),
    );
    const reasoning = [...(row?.querySelectorAll("label") ?? [])].find(
      (l) => l.textContent === "reasoning",
    );
    reasoning?.querySelector("input")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}").models).toEqual([
      { id: "bedrock-claude-opus-5-5", capabilities: ["chat", "reasoning"] },
      { id: "gpt-typo", capabilities: ["chat"] },
    ]);
  });

  it("keeps a model's last tag, since an untagged model would be offered nowhere", async () => {
    const host = await mount();
    button(host, "Edit")?.click();
    await settle();

    const row = [...host.querySelectorAll("li")].find((li) =>
      li.textContent?.startsWith("gpt-typo"),
    );
    const chat = [...(row?.querySelectorAll("label") ?? [])].find((l) => l.textContent === "chat");
    chat?.querySelector("input")?.click();
    await settle();
    button(host, "Save")?.click();
    await settle();

    const patch = calls.find((c) => c.method === "PATCH");
    expect(JSON.parse(patch?.body ?? "{}").models[1]).toEqual({
      id: "gpt-typo",
      capabilities: ["chat"],
    });
  });
});
