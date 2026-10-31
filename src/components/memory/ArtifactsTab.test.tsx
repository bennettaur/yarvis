import { afterEach, describe, expect, it, mock } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";

const ARTIFACTS = [
  {
    id: "a1",
    title: "Morning brief",
    format: "markdown",
    createdBy: "specialist",
    untrusted: true,
    length: 120,
    createdAt: "2026-10-30T08:00:00.000Z",
    updatedAt: "2026-10-30T08:05:00.000Z",
  },
  {
    id: "a2",
    title: "Heads-down scratchpad",
    format: "markdown",
    createdBy: "heads-down",
    untrusted: true,
    length: 40,
    createdAt: "2026-10-29T09:00:00.000Z",
    updatedAt: "2026-10-29T17:00:00.000Z",
  },
  {
    id: "a3",
    title: "Trip plan",
    format: "markdown",
    createdBy: "chat",
    untrusted: false,
    length: 10,
    createdAt: "2026-10-28T09:00:00.000Z",
    updatedAt: "2026-10-28T17:00:00.000Z",
  },
];

let listed: { id: string }[] = ARTIFACTS;
/** Every delete request the tab made, as method and path plus the body's ids. */
let deletes: { method: string; path: string; ids?: string[] }[] = [];
/** Set to make the next delete answer with a server error. */
let failNextDelete = false;

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
  // A small fake of the artifact routes: deletes take the rows out of `listed`.
  sidecarFetch: async (path: string, init: RequestInit = {}) => {
    const method = init.method ?? "GET";
    let body: unknown = listed;
    if (method !== "GET" && failNextDelete) {
      failNextDelete = false;
      return new Response("boom", { status: 500 });
    }
    if (method === "DELETE") {
      const id = path.split("/").pop();
      deletes.push({ method, path });
      listed = listed.filter((a) => a.id !== id);
      body = { deleted: true };
    } else if (method === "POST") {
      const { ids } = JSON.parse(String(init.body)) as { ids: string[] };
      deletes.push({ method, path, ids });
      listed = listed.filter((a) => !ids.includes(a.id));
      body = { deleted: ids.length };
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  },
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

  it("shows who wrote each artifact and flags the untrusted ones", async () => {
    listed = ARTIFACTS;
    clearResourceCache();
    const text = textOf(await renderToHtml(createElement(ArtifactsTab)));
    expect(text).toContain("Specialist or job");
    expect(text).toContain("Heads-down ·");
    expect(text).toContain("Chat ·");
    expect(text.match(/untrusted/g)).toHaveLength(2);
  });
});

describe("ArtifactsTab deleting", () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
  const buttonNamed = (host: HTMLElement, label: string) =>
    Array.from(host.querySelectorAll("button")).find(
      (b) => b.textContent === label || b.getAttribute("aria-label") === label,
    );
  const checkbox = (host: HTMLElement, label: string) =>
    host.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement;

  let unmount: (() => void) | null = null;
  afterEach(() => {
    unmount?.();
    unmount = null;
  });

  const mount = async () => {
    listed = [...ARTIFACTS];
    deletes = [];
    clearResourceCache();
    const mounted = await mountForInteraction(createElement(ArtifactsTab));
    unmount = mounted.unmount;
    return mounted.host;
  };

  it("deletes one artifact from its row", async () => {
    const host = await mount();
    buttonNamed(host, "Delete Trip plan")?.click();
    await settle();
    expect(deletes).toEqual([{ method: "DELETE", path: "/api/artifacts/a3" }]);
    expect(host.textContent).not.toContain("Trip plan");
    expect(host.textContent).toContain("Morning brief");
  });

  it("deletes the selected artifacts together, only after a confirm", async () => {
    const host = await mount();
    checkbox(host, "Select Morning brief").click();
    checkbox(host, "Select Trip plan").click();
    await settle();
    expect(host.textContent).toContain("2 selected");

    buttonNamed(host, "Delete selected")?.click();
    await settle();
    expect(deletes).toEqual([]);
    expect(host.textContent).toContain("Delete 2 for good?");

    buttonNamed(host, "Delete 2")?.click();
    await settle();
    expect(deletes).toEqual([{ method: "POST", path: "/api/artifacts/delete", ids: ["a1", "a3"] }]);
    expect(host.textContent).not.toContain("Morning brief");
    expect(host.textContent).not.toContain("Trip plan");
    expect(host.textContent).toContain("Heads-down scratchpad");
    expect(host.textContent).toContain("Select to delete several");
  });

  it("keeps the selection and says so when a bulk delete fails", async () => {
    const host = await mount();
    checkbox(host, "Select Trip plan").click();
    await settle();
    buttonNamed(host, "Delete selected")?.click();
    await settle();
    failNextDelete = true;
    buttonNamed(host, "Delete 1")?.click();
    await settle();

    expect(host.querySelector("[role='alert']")?.textContent).toContain("500");
    expect(host.textContent).toContain("Trip plan");
    expect(host.textContent).toContain("1 selected");
  });

  it("selects every artifact with the select-all box, and cancels without deleting", async () => {
    const host = await mount();
    checkbox(host, "Select all artifacts").click();
    await settle();
    expect(host.textContent).toContain("3 selected");

    buttonNamed(host, "Delete selected")?.click();
    await settle();
    buttonNamed(host, "Cancel")?.click();
    await settle();
    expect(deletes).toEqual([]);
    expect(host.textContent).toContain("3 selected");
  });
});
