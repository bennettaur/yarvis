import { describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { renderToHtml, textOf } from "../test/render";

const JOBS = [
  {
    name: "consolidate-events",
    description: "Every four hours, summarize the activity events not yet folded into memory.",
    schedule: { kind: "interval", everyMs: 4 * 60 * 60 * 1000 },
    lastStartedAt: "2026-08-24T12:00:00.000Z",
    lastFinishedAt: "2026-08-24T12:00:04.000Z",
    lastStatus: "ok",
    lastError: null,
    running: false,
    due: false,
  },
  {
    name: "cc-session-digest",
    description: "Overnight, summarize new or extended Claude Code sessions.",
    schedule: { kind: "daily", hour: 2 },
    lastStartedAt: null,
    lastFinishedAt: null,
    lastStatus: null,
    lastError: null,
    running: false,
    due: true,
  },
];

const CONFIG = {
  config: { ccDigestEnabled: false, ccDigestProjectDirs: [] },
  availableProjectDirs: [{ dir: "-Users-me-dev-app", path: "/Users/me/dev/app" }],
};

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
  sidecarFetch: async (path: string) =>
    new Response(JSON.stringify(path.includes("/config") ? CONFIG : { jobs: JOBS }), {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
}));

const JobsSection = (await import("./JobsSection")).default;

describe("JobsSection", () => {
  it("renders each job's schedule in plain words", async () => {
    const text = textOf(await renderToHtml(createElement(JobsSection)));
    expect(text).toContain("every 4h");
    expect(text).toContain("daily around 02:00");
  });

  it("distinguishes a job that has run from one that never has", async () => {
    const text = textOf(await renderToHtml(createElement(JobsSection)));
    expect(text).toContain("ok");
    expect(text).toContain("never run");
    expect(text).toContain("due");
  });

  it("says the transcript digest is off and why, before offering projects", async () => {
    const html = await renderToHtml(createElement(JobsSection));
    const text = textOf(html);
    expect(text).toContain("Summarize my Claude Code sessions each night");
    expect(text).toContain("sent to your configured LLM provider");
    // Off, so the project list stays hidden until it is enabled.
    expect(text).not.toContain("/Users/me/dev/app");
    expect(html).toContain("checkbox");
  });
});
