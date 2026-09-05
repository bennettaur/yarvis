import { beforeEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import type { IssueRepo, IssueSummary } from "../../lib/issues/types";

const repos: IssueRepo[] = [
  { id: "r1", owner: "octo", repo: "web", name: "web" },
  { id: "r2", owner: "octo", repo: "api", name: "api" },
];

const sent: { path: string; method: string; body: Record<string, unknown> | null }[] = [];

// Stubbing the transport keeps the create route's path and body under test.
mock.module("../../lib/api", () => ({
  sidecarInfo: async () => ({ port: 0, token: "test-token" }),
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
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    sent.push({
      path,
      method: init.method ?? "GET",
      body: init.body ? JSON.parse(String(init.body)) : null,
    });
    return new Response(JSON.stringify({ externalId: "12", title: "Fix the thing" }), {
      status: 201,
    });
  },
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
  streamSSE: () => () => {},
}));

const { default: GithubCreateIssueModal } = await import("./GithubCreateIssueModal");

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

async function mount() {
  const created: IssueSummary[] = [];
  let closed = false;
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  root.render(
    createElement(GithubCreateIssueModal, {
      repos,
      onClose: () => {
        closed = true;
      },
      onCreated: (issue: IssueSummary) => created.push(issue),
    }),
  );
  await settle();
  return {
    host,
    created,
    wasClosed: () => closed,
    cleanup: () => {
      root.unmount();
      host.remove();
    },
  };
}

const button = (host: HTMLElement, label: string) =>
  Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);

/** Types into a React-controlled field (React tracks the value setter itself). */
function type(field: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto =
    field.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")?.set?.call(field, value);
  field.dispatchEvent(new Event("input", { bubbles: true }));
}

beforeEach(() => {
  sent.length = 0;
});

describe("GithubCreateIssueModal", () => {
  it("offers every repo configured to pull issues", async () => {
    const { host, cleanup } = await mount();
    const options = Array.from(host.querySelectorAll("option")).map((o) => o.textContent);
    expect(options).toEqual(["octo/web", "octo/api"]);
    cleanup();
  });

  it("disables Create until a title is typed", async () => {
    const { host, cleanup } = await mount();
    expect(button(host, "Create")?.disabled).toBe(true);
    const field = host.querySelector("input");
    if (field) type(field, "Fix the thing");
    await settle();
    expect(button(host, "Create")?.disabled).toBe(false);
    cleanup();
  });

  it("posts the trimmed title and body to the selected repo, then closes", async () => {
    const { host, created, wasClosed, cleanup } = await mount();
    const title = host.querySelector("input");
    if (title) type(title, "  Fix the thing  ");
    const body = host.querySelector("textarea");
    if (body) type(body, " details ");
    await settle();
    button(host, "Create")?.click();
    await settle();
    expect(sent).toContainEqual({
      path: "/api/issues/github/create/octo/web",
      method: "POST",
      body: { title: "Fix the thing", body: "details" },
    });
    expect(created).toHaveLength(1);
    expect(wasClosed()).toBe(true);
    cleanup();
  });
});
