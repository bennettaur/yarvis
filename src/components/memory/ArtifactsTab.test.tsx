import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../../test/render";

const ARTIFACTS = [
  {
    id: "a1",
    title: "Morning brief",
    format: "markdown",
    length: 120,
    createdAt: "2026-10-30T08:00:00.000Z",
    updatedAt: "2026-10-30T08:05:00.000Z",
  },
  {
    id: "a2",
    title: "Heads-down scratchpad",
    format: "markdown",
    length: 40,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T17:00:00.000Z",
  },
];

let listed: unknown[] = ARTIFACTS;

mock.module("../../lib/api", () => ({
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
    new Response(JSON.stringify(listed), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const ArtifactsTab = (await import("./ArtifactsTab")).default;
const { clearResourceCache } = await import("../../lib/resourceCache");

describe("ArtifactsTab", () => {
  it("lists each artifact by title", async () => {
    listed = ARTIFACTS;
    clearResourceCache();
    const text = textOf(await renderToHtml(createElement(ArtifactsTab)));
    expect(text).toContain("Morning brief");
    expect(text).toContain("Heads-down scratchpad");
    expect(text).toContain("Pick an artifact to read it.");
  });

  it("says so when the assistant hasn't written anything", async () => {
    listed = [];
    clearResourceCache();
    const text = textOf(await renderToHtml(createElement(ArtifactsTab)));
    expect(text).toContain("hasn't written anything yet");
  });
});
