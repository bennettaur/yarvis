import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml } from "../test/render";
import McpEndpointSection, { claudeAddCommand } from "./McpEndpointSection";

const ENDPOINT = { url: "http://127.0.0.1:8765/mcp", token: "s3cret-mcp-token" };

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
  sidecarFetch: async () =>
    new Response(JSON.stringify(ENDPOINT), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

let unmount: (() => void) | null = null;

afterEach(() => {
  unmount?.();
  unmount = null;
});

describe("McpEndpointSection", () => {
  it("shows the endpoint but keeps the token masked until asked for", async () => {
    const html = await renderToHtml(createElement(McpEndpointSection));
    expect(html).toContain("http://127.0.0.1:8765/mcp");
    expect(html).not.toContain("s3cret-mcp-token");
    expect(html).toContain("Show");
  });

  it("reveals the token when Show is clicked", async () => {
    const mounted = await mountForInteraction(createElement(McpEndpointSection));
    unmount = mounted.unmount;

    const show = [...mounted.host.querySelectorAll("button")].find((b) => b.textContent === "Show");
    show?.click();
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mounted.host.innerHTML).toContain("s3cret-mcp-token");
  });

  it("hands the user a runnable connect command", () => {
    // The whole point of the section: this string is pasted into a terminal, so
    // the flags and the quoting around the header are the deliverable.
    expect(claudeAddCommand(ENDPOINT)).toBe(
      'claude mcp add --transport http yarvis http://127.0.0.1:8765/mcp --header "Authorization: Bearer s3cret-mcp-token"',
    );
  });
});
