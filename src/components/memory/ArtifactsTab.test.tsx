import { afterAll, afterEach, describe, expect, it } from "bun:test";
import { createElement } from "react";
import { mountForInteraction, renderToHtml, textOf } from "../../test/render";
import { resetSidecarApi, stubSidecarApi } from "../../test/sidecarApi";

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

let listed: { id: string; updatedAt?: string }[] = ARTIFACTS;
/** What reading one artifact returns, by id. */
let contents: Record<string, string> = {};
/** Every single-artifact read the tab made. */
let reads: string[] = [];
/** Set to make listing answer with a server error. */
let failList = false;
/** Every delete request the tab made, as method and path plus the body's ids. */
let deletes: { method: string; path: string; ids?: string[] }[] = [];
/** Set to make the next delete answer with a server error. */
let failNextDelete = false;

stubSidecarApi({
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
    const readId = path.match(/^\/api\/artifacts\/(\w+)$/)?.[1];
    if (method === "GET" && failList && path === "/api/artifacts") {
      return new Response("boom", { status: 500 });
    }
    if (method === "GET" && readId) {
      reads.push(readId);
      const row = ARTIFACTS.find((a) => a.id === readId)!;
      body = { ...row, ...listed.find((a) => a.id === readId), content: contents[readId] };
    } else if (method === "DELETE") {
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
});

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
    reads = [];
    contents = { a1: "**Top** of the day", a3: "Pack the charger" };
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
    // Keyboard focus lands on Cancel, not back on the page.
    expect(document.activeElement?.textContent).toBe("Cancel");
    buttonNamed(host, "Cancel")?.click();
    await settle();
    expect(deletes).toEqual([]);
    expect(host.textContent).toContain("3 selected");

    checkbox(host, "Select all artifacts").click();
    await settle();
    expect(host.textContent).toContain("Select to delete several");
    expect(checkbox(host, "Select Trip plan").checked).toBe(false);
  });

  const titleButton = (host: HTMLElement, title: string) =>
    Array.from(host.querySelectorAll("button")).find((b) =>
      b.querySelector("p")?.textContent?.startsWith(title),
    )!;

  it("opens an artifact to read, with where it came from", async () => {
    const host = await mount();
    titleButton(host, "Morning brief").click();
    await settle();
    expect(reads).toEqual(["a1"]);
    expect(host.textContent).not.toContain("Pick an artifact to read it.");
    expect(host.textContent).toContain("Source: Specialist or job");
    expect(host.querySelector("strong")?.textContent).toBe("Top");
  });

  it("reads an open artifact again once the agent has changed it", async () => {
    const host = await mount();
    titleButton(host, "Morning brief").click();
    await settle();

    contents.a1 = "Appended by a pass";
    listed = listed.map((a) =>
      a.id === "a1" ? { ...a, updatedAt: "2026-10-30T09:00:00.000Z" } : a,
    );
    // Deleting another artifact refreshes the list, which carries the new update time.
    buttonNamed(host, "Delete Heads-down scratchpad")?.click();
    await settle();
    expect(reads).toEqual(["a1", "a1"]);
    expect(host.textContent).toContain("Appended by a pass");
  });

  it("closes the reader when the open artifact is deleted", async () => {
    const host = await mount();
    titleButton(host, "Trip plan").click();
    await settle();
    expect(host.textContent).toContain("Pack the charger");

    buttonNamed(host, "Delete Trip plan")?.click();
    await settle();
    expect(host.textContent).toContain("Pick an artifact to read it.");
    expect(host.textContent).not.toContain("Pack the charger");
  });

  it("says so when the list can't be loaded", async () => {
    failList = true;
    try {
      const host = await mount();
      expect(host.textContent).toContain("500");
    } finally {
      failList = false;
    }
  });
});

afterAll(resetSidecarApi);
